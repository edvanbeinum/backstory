import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyClaudeSetup,
  planClaudeSetup,
  planClaudeUndo,
  shellQuote,
  undoClaudeSetup,
} from "../bin/claude-setup.mjs";
import { isBackstoryHook } from "../bin/hook.mjs";
import { setupChecks } from "../lib/setup";
import { quietLoginShell, standIns } from "./standins";

quietLoginShell();

const SCRIPT = "/Applications/Backstory.app/Contents/Resources/bin/backstory";
const COMMAND = `'${SCRIPT}' hook stop`;

/** A temp folder standing in for `~/.claude`, with `settings.json` when given. */
function claudeDir(settings?: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "backstory-claude-"));
  if (settings !== undefined)
    writeFileSync(
      path.join(dir, "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  return dir;
}

const settingsOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
const commandFile = (dir: string) =>
  path.join(dir, "commands", "backstory-review.md");
const stopGroup = (...commands: string[]) => ({
  hooks: commands.map((command) => ({ type: "command", command })),
});

async function reviewsRow(dir: string) {
  const saved = process.env.PATH;
  process.env.PATH = standIns({});
  try {
    const rows = await setupChecks({ claudeDir: dir });
    return rows.find((row) => row.id === "reviews")?.state;
  } finally {
    process.env.PATH = saved;
  }
}

test("setup writes one Stop hook and /backstory-review, both naming the app's command", () => {
  const dir = claudeDir();
  assert.equal(
    applyClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
    "none",
  );
  assert.deepEqual(settingsOf(dir), {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: COMMAND, timeout: 10 }] }],
    },
  });
  const review = readFileSync(commandFile(dir), "utf8");
  assert.match(
    review,
    new RegExp(`allowed-tools: Bash\\('${SCRIPT}' review:\\*\\)`),
  );
  assert.ok(review.includes(`Run \`'${SCRIPT}' review\``));
  assert.ok(!/(^|[^/'])backstory review/m.test(review));
  assert.ok(
    readFileSync(path.join(dir, "settings.json"), "utf8").endsWith("}\n"),
  );
});

test("the setup checklist's Notes to your agent row ticks after setup and clears after undo", async () => {
  const dir = claudeDir();
  assert.equal(await reviewsRow(dir), "missing");
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(await reviewsRow(dir), "ready");
  undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(await reviewsRow(dir), "missing");
});

test("setup keeps other Stop hooks, other events and other keys, in their order", () => {
  const before = {
    model: "opus",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] },
      ],
      Stop: [stopGroup("notify-me")],
    },
    permissions: { allow: ["Bash(ls:*)"] },
  };
  const dir = claudeDir(before);
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  const after = settingsOf(dir);
  assert.deepEqual(Object.keys(after), ["model", "hooks", "permissions"]);
  assert.deepEqual(Object.keys(after.hooks), ["PreToolUse", "Stop"]);
  assert.deepEqual(after.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.hooks.Stop[0], stopGroup("notify-me"));
  assert.equal(after.hooks.Stop[1].hooks[0].command, COMMAND);
});

test("setting up twice leaves one Backstory hook, and the second check reports current", () => {
  const dir = claudeDir({ hooks: { Stop: [stopGroup("notify-me")] } });
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  const once = readFileSync(path.join(dir, "settings.json"), "utf8");
  assert.equal(
    planClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
    "current",
  );
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), once);
  const commands = settingsOf(dir).hooks.Stop.flatMap(
    (group: { hooks: { command: string }[] }) =>
      group.hooks.map((h) => h.command),
  );
  assert.equal(commands.filter(isBackstoryHook).length, 1);
});

for (const [name, old] of [
  [
    "an old app path",
    "'/Volumes/Backstory/Backstory.app/Contents/Resources/bin/backstory' hook stop",
  ],
  ["a bare backstory hook stop", "backstory hook stop"],
]) {
  test(`setup takes over ${name} in place, in its own group`, () => {
    const dir = claudeDir({
      hooks: {
        Stop: [stopGroup("notify-me"), stopGroup("first", old, "last")],
      },
    });
    const plan = planClaudeSetup({ claudeDir: dir, script: SCRIPT });
    assert.equal(plan.state, "stale");
    assert.ok(plan.changes.some((change) => change.includes(old)));
    applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
    assert.deepEqual(settingsOf(dir).hooks.Stop, [
      stopGroup("notify-me"),
      stopGroup("first", COMMAND, "last"),
    ]);
  });
}

test("setup drops a second Backstory hook, so one is left", () => {
  const dir = claudeDir({
    hooks: {
      Stop: [
        stopGroup("backstory hook stop"),
        stopGroup("backstory hook stop"),
      ],
    },
  });
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.deepEqual(settingsOf(dir).hooks.Stop, [stopGroup(COMMAND)]);
});

test("setup and undo leave a command that chains backstory hook stop after another", () => {
  const chained = "notify-me && backstory hook stop";
  const dir = claudeDir({ hooks: { Stop: [stopGroup(chained)] } });
  assert.equal(
    planClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
    "none",
  );
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.deepEqual(settingsOf(dir).hooks.Stop, [
    stopGroup(chained),
    { hooks: [{ type: "command", command: COMMAND, timeout: 10 }] },
  ]);
  undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.deepEqual(settingsOf(dir).hooks.Stop, [stopGroup(chained)]);
});

test("undo takes out only Backstory's hook and the groups it leaves empty", () => {
  const dir = claudeDir({
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [] }],
      Stop: [
        stopGroup("notify-me", "backstory hook stop"),
        stopGroup("backstory hook stop"),
      ],
    },
  });
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.deepEqual(settingsOf(dir), {
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [] }],
      Stop: [stopGroup("notify-me")],
    },
  });
});

test("Remove offers to take out a stale hook, and does", () => {
  const old =
    "'/Volumes/Backstory/Backstory.app/Contents/Resources/bin/backstory' hook stop";
  const dir = claudeDir({ hooks: { Stop: [stopGroup("notify-me", old)] } });
  assert.equal(
    planClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
    "stale",
  );
  assert.deepEqual(planClaudeUndo({ claudeDir: dir, script: SCRIPT }), {
    state: "remove",
    changes: [
      `Remove the Stop hook ${old} from ${path.join(dir, "settings.json")}`,
    ],
  });
  undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.deepEqual(settingsOf(dir).hooks.Stop, [stopGroup("notify-me")]);
});

test("Remove offers nothing when Backstory isn't set up, and on a broken file says why", () => {
  assert.deepEqual(
    planClaudeUndo({ claudeDir: claudeDir({}), script: SCRIPT }).changes,
    [],
  );
  assert.equal(
    planClaudeUndo({ claudeDir: claudeDir("{"), script: SCRIPT }).state,
    "error",
  );
});

test("undo after setup on a fresh folder leaves no hooks key behind", () => {
  const dir = claudeDir({ model: "opus" });
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(
    planClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
    "current",
  );
  const removed = undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(removed.changes.length, 2);
  assert.deepEqual(settingsOf(dir), { model: "opus" });
  assert.equal(existsSync(commandFile(dir)), false);
});

test("undo leaves a /backstory-review copied by hand", () => {
  const dir = claudeDir({
    hooks: { Stop: [stopGroup("backstory hook stop")] },
  });
  mkdirSync(path.join(dir, "commands"));
  const byHand = readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "packaging",
      "claude",
      "backstory-review.md",
    ),
    "utf8",
  );
  writeFileSync(commandFile(dir), byHand);
  undoClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(readFileSync(commandFile(dir), "utf8"), byHand);
  assert.deepEqual(settingsOf(dir), {});
});

for (const [name, text] of [
  ["invalid JSON", "{ not json"],
  ["a top-level array", "[]"],
]) {
  test(`${name} reports error and is left byte for byte`, () => {
    const dir = claudeDir(text);
    const plan = planClaudeSetup({ claudeDir: dir, script: SCRIPT });
    assert.equal(plan.state, "error");
    assert.ok(plan.message);
    assert.equal(
      applyClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
      "error",
    );
    assert.equal(
      undoClaudeSetup({ claudeDir: dir, script: SCRIPT }).state,
      "error",
    );
    assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), text);
    assert.equal(existsSync(commandFile(dir)), false);
  });
}

test("a symlinked settings.json stays a link, and its target is updated", () => {
  const dotfiles = claudeDir({ model: "opus" });
  const dir = claudeDir();
  symlinkSync(
    path.join(dotfiles, "settings.json"),
    path.join(dir, "settings.json"),
  );
  applyClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.ok(lstatSync(path.join(dir, "settings.json")).isSymbolicLink());
  assert.equal(settingsOf(dotfiles).hooks.Stop[0].hooks[0].command, COMMAND);
});

test("a script path with a space and a quote still runs under sh -c", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "backstory it's here "));
  const script = path.join(parent, "Contents", "Resources", "bin", "backstory");
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, '#!/bin/sh\necho "ran: $*"\n', { mode: 0o755 });
  const dir = claudeDir();
  applyClaudeSetup({ claudeDir: dir, script });
  const command = settingsOf(dir).hooks.Stop[0].hooks[0].command;
  assert.equal(command, `${shellQuote(script)} hook stop`);
  assert.ok(isBackstoryHook(command));
  assert.equal(
    execFileSync("sh", ["-c", command], { encoding: "utf8" }),
    "ran: hook stop\n",
  );
});

test("check reports none, current, stale and error", () => {
  const plan = (dir: string) =>
    planClaudeSetup({ claudeDir: dir, script: SCRIPT });
  assert.equal(plan(claudeDir()).state, "none");

  const current = claudeDir();
  applyClaudeSetup({ claudeDir: current, script: SCRIPT });
  assert.equal(plan(current).state, "current");
  assert.ok(
    plan(current).changes.every((change) => /^(Remove|Delete)/.test(change)),
  );

  const moved = claudeDir();
  applyClaudeSetup({
    claudeDir: moved,
    script:
      "/Users/me/Downloads/Backstory.app/Contents/Resources/bin/backstory",
  });
  assert.equal(plan(moved).state, "stale");

  const noCommand = claudeDir({ hooks: { Stop: [stopGroup(COMMAND)] } });
  assert.equal(plan(noCommand).state, "stale");
  assert.deepEqual(plan(noCommand).changes, [
    `Add /backstory-review at ${commandFile(noCommand)}`,
  ]);

  assert.equal(plan(claudeDir("{")).state, "error");
});

test("setup refuses without the Mac app's command beside it", () => {
  assert.throws(
    () => planClaudeSetup({ claudeDir: claudeDir(), script: null }),
    /Mac app/,
  );
});

test("only a whole backstory hook stop command counts as Backstory's", () => {
  for (const command of [
    "backstory hook stop",
    COMMAND,
    `"${SCRIPT}" hook stop`,
    `${SCRIPT} hook stop  `,
    `${shellQuote("/tmp/it's here/backstory")} hook stop`,
  ])
    assert.ok(isBackstoryHook(command), command);
  for (const command of [
    "notify-me",
    "backstory hook stop --x",
    "mybackstory hook stop",
    "notify-me && backstory hook stop",
    "notify-me; backstory hook stop",
    `cd /tmp && '${SCRIPT}' hook stop`,
    3,
  ])
    assert.ok(!isBackstoryHook(command), String(command));
});
