import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Runner } from "../lib/ai/provider";
import { setAutoRead } from "../lib/data/cache";
import {
  descriptionReadSettled,
  descriptionStatus,
  startDescription,
  toDescription,
  type DescriptionView,
  type PrText,
} from "../lib/description/cache";
import {
  BAD_EXAMPLES,
  GOOD_EXAMPLES,
  WRITING_RULES,
  type DescriptionOutput,
} from "../lib/description/prompt";
import { isOnMap, startsByItself } from "../lib/description/types";
import { buildMap } from "../lib/map";
import { MAX_PATCH_BYTES } from "../lib/data/drafted";
import { repoKey } from "../lib/git";
import { serializeModel } from "../lib/models/dsl";
import type { MapDelta } from "../lib/models/delta";
import type { DraftOutput } from "../lib/models/prompts";
import { homeDir } from "../lib/store";

const previousHome = process.env.BACKSTORY_HOME;
const home = mkdtempSync(
  path.join(os.tmpdir(), "backstory-descriptions-home-"),
);
process.env.BACKSTORY_HOME = home;
const dirs: string[] = [home];
after(() => {
  if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
  else process.env.BACKSTORY_HOME = previousHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SHOP: DraftOutput = {
  name: "Shop",
  description: "Sells things",
  people: [],
  externalSystems: [],
  system: {
    id: "shop",
    name: "Shop",
    description: "The shop",
    containers: [
      {
        id: "web",
        name: "Web",
        description: "The site",
        technology: "Node",
        components: [
          {
            id: "app",
            name: "Checkout",
            description: "Takes the order",
            technology: "TypeScript",
            globs: ["src/app/**"],
          },
          {
            id: "sync",
            name: "Sync Engine",
            description: "Sends orders on",
            technology: "TypeScript",
            globs: ["src/sync/**"],
          },
        ],
      },
    ],
  },
  relationships: [],
  tests: [],
  ignore: ["**/*.md", "**/*.txt"],
};

/**
 * A repo that commits the shop's map, or with `drafted` has none for Backstory
 * to draw, with one change to Sync Engine on top.
 */
function shopRepo({ drafted = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-descriptions-"));
  dirs.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      const at = path.join(root, file);
      mkdirSync(path.dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit(
    {
      ...(drafted
        ? {}
        : { "architecture/workspace.dsl": serializeModel(SHOP) }),
      "src/app/checkout.ts": "export const checkout = 1;\n",
      "src/sync/engine.ts": "export const retries = 0;\n",
    },
    "Start the shop",
  );
  const head = commit(
    { "src/sync/engine.ts": "export const retries = 3;\n" },
    "Retry a failed upload three times\n\nOrders went missing when the network dropped for a moment.",
  );
  const view: DescriptionView = { root, base, head };
  return { root, git, commit, base, head, view };
}

const ANSWER: DescriptionOutput = {
  what: "Retries a failed upload in Sync Engine three times.",
  why: "Orders went missing when the network dropped for a moment.",
  lookFirst: [{ name: "Sync Engine", reason: "The retry count changed." }],
};

/** A stand-in for the AI provider: answers `answer`, or throws `fail`, and records each prompt. */
function recorder(opts: { answer?: DescriptionOutput; fail?: string } = {}) {
  const prompts: string[] = [];
  const runner: Runner = async <T>(prompt: string) => {
    prompts.push(prompt);
    if (opts.fail) throw new Error(opts.fail);
    return {
      output: structuredClone(opts.answer ?? ANSWER) as T,
      costUsd: 0.01,
      model: "test-model",
    };
  };
  return { runner, prompts };
}

const ready = async () => "ready" as const;
const PR = async (): Promise<PrText> => ({
  title: "Retry uploads",
  body: "Shoppers lost orders on a flaky connection.",
});

async function read(
  view: DescriptionView,
  opts: Parameters<typeof startDescription>[1] = {},
) {
  const started = await startDescription(view, { status: ready, ...opts });
  await descriptionReadSettled(view);
  return started;
}

const cacheDir = async (root: string) =>
  path.join(homeDir(), "descriptions", await repoKey(root));

test("a view's description is read once from its patch, commits, PR and component names, and cached", async () => {
  const repo = shopRepo();
  const ai = recorder();
  await read(repo.view, { runner: ai.runner, pr: PR });

  assert.equal(ai.prompts.length, 1);
  const prompt = ai.prompts[0];
  assert.match(prompt, /\+export const retries = 3;/);
  assert.match(prompt, /Retry a failed upload three times/);
  assert.match(prompt, /Orders went missing when the network dropped/);
  assert.match(prompt, /Retry uploads/);
  assert.match(prompt, /Shoppers lost orders on a flaky connection\./);
  assert.match(prompt, /^- Sync Engine$/m);
  assert.doesNotMatch(prompt, /^- Checkout$/m);

  const done = await descriptionStatus(repo.view);
  assert.equal(done.status, "done");
  assert.deepEqual(done.status === "done" && done.description, {
    what: ANSWER.what,
    why: ANSWER.why,
    lookFirst: [ANSWER.lookFirst[0]],
  });
  assert.equal(done.status === "done" && done.provider, "Claude Code");
  assert.equal(done.status === "done" && done.model, "test-model");

  await read(repo.view, { runner: ai.runner, pr: PR });
  assert.equal(ai.prompts.length, 1);
  assert.deepEqual(await descriptionStatus(repo.view), done);
});

test("in a repo with a drafted map, the description waits for the view's map read and names its components", async () => {
  const repo = shopRepo({ drafted: true });
  const ai = recorder();
  const reads: string[] = [];
  const runner: Runner = async <T>(
    prompt: string,
    schema: object,
    cwd: string,
  ) => {
    if (prompt.startsWith("You are describing"))
      return ai.runner<T>(prompt, schema, cwd);
    const drafted = prompt.includes("The patch:")
      ? ({
          changed: [],
          absent: [],
          arrows: [],
          absentArrows: [],
          tests: null,
          ignore: null,
        } satisfies MapDelta)
      : SHOP;
    reads.push(prompt.includes("The patch:") ? "delta" : "full");
    return { output: structuredClone(drafted) as T, costUsd: 0.1, model: "m" };
  };
  await read(repo.view, { runner });

  assert.ok(reads.length > 0);
  assert.equal(ai.prompts.length, 1);
  assert.match(ai.prompts[0], /^- Sync Engine$/m);
});

test("the prompt states every writing rule, with two good and two bad examples", async () => {
  const repo = shopRepo();
  const ai = recorder();
  await read(repo.view, { runner: ai.runner });

  assert.equal(WRITING_RULES.length, 7);
  assert.equal(GOOD_EXAMPLES.length, 2);
  assert.equal(BAD_EXAMPLES.length, 2);
  for (const line of [...WRITING_RULES, ...GOOD_EXAMPLES, ...BAD_EXAMPLES])
    assert.ok(ai.prompts[0].includes(line), line);
  for (const rule of [
    /Lead with the point/,
    /Use the real names given/,
    /"seamless", "robust", "leverage", "enhance", "streamline", "carries", "holds"/,
    /No openers like "This change…" or "This PR…"/,
    /A sentence that could describe any change is cut/,
    /why comes only from the commit messages and the pull request/,
    /copied exactly\. At most 2/,
  ])
    assert.match(ai.prompts[0], rule);
});

test("with no why given, the description has none, and nothing is filled in", async () => {
  const repo = shopRepo();
  await read(repo.view, {
    runner: recorder({ answer: { ...ANSWER, why: null } }).runner,
  });
  const done = await descriptionStatus(repo.view);
  assert.equal(done.status === "done" && done.description.why, null);

  assert.equal(toDescription({ ...ANSWER, why: "  " }).why, null);
});

test("where to look first names are trimmed and each kept once", () => {
  assert.deepEqual(
    toDescription({
      ...ANSWER,
      lookFirst: [
        { name: "Sync Engine ", reason: "The retry count." },
        { name: "Sync Engine", reason: "Again." },
        { name: " ", reason: "Blank." },
        { name: "Order", reason: "An entity." },
      ],
    }).lookFirst,
    [
      { name: "Sync Engine", reason: "The retry count." },
      { name: "Order", reason: "An entity." },
    ],
  );
});

test("where to look first is matched to the map's names exactly, and a name not on it stays as text", async () => {
  const repo = shopRepo();
  await read(repo.view, {
    runner: recorder({
      answer: {
        ...ANSWER,
        lookFirst: [
          { name: "Sync Engine", reason: "The retry count." },
          { name: "Order", reason: "An entity." },
          { name: "Checkout", reason: "A third, past the limit." },
        ],
      },
    }).runner,
  });
  const done = await descriptionStatus(repo.view);
  const map = await buildMap(repo.view.root, repo.view.base, repo.view.head);
  assert.deepEqual(
    done.status === "done" &&
      done.description.lookFirst.map((l) => [l.name, isOnMap(l.name, map)]),
    [
      ["Sync Engine", true],
      ["Order", false],
    ],
  );
  assert.equal(isOnMap("sync engine", map), false);
  assert.equal(isOnMap("Sync Engine", null), false);
});

test("commits with the same trees as a described view use its description", async () => {
  const repo = shopRepo();
  await read(repo.view, { runner: recorder().runner });

  const tree = (rev: string) => repo.git("rev-parse", `${rev}^{tree}`);
  const base = repo.git("commit-tree", tree(repo.base), "-m", "Reworded");
  const head = repo.git(
    "commit-tree",
    tree(repo.head),
    "-p",
    base,
    "-m",
    "Reworded too",
  );
  assert.notEqual(head, repo.head);
  const rebased = { root: repo.root, base, head };
  const ai = recorder();
  await read(rebased, { runner: ai.runner });
  assert.equal(ai.prompts.length, 0);
  assert.equal((await descriptionStatus(rebased)).status, "done");
});

test("a read is idle, then running, then done", async () => {
  const repo = shopRepo();
  assert.deepEqual(await descriptionStatus(repo.view), {
    status: "idle",
    provider: "Claude Code",
    auto: true,
  });

  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered = () => {};
  const reading = new Promise<void>((resolve) => (entered = resolve));
  const inner = recorder();
  const gated: Runner = async <T>(
    prompt: string,
    schema: object,
    cwd: string,
  ) => {
    entered();
    await gate;
    return inner.runner<T>(prompt, schema, cwd);
  };
  await startDescription(repo.view, { runner: gated, status: ready });
  await reading;
  assert.equal((await descriptionStatus(repo.view)).status, "running");
  assert.equal(
    (await startDescription(repo.view, { runner: gated, status: ready }))
      .status,
    "running",
  );

  open();
  await descriptionReadSettled(repo.view);
  assert.equal((await descriptionStatus(repo.view)).status, "done");
  assert.equal(inner.prompts.length, 1);
});

test("a failed read says why, caches nothing, and Describe again reads it once more", async () => {
  const repo = shopRepo();
  await read(repo.view, {
    runner: recorder({ fail: "Claude Code failed: blocked" }).runner,
  });
  assert.deepEqual(await descriptionStatus(repo.view), {
    status: "failed",
    error: "Claude Code failed: blocked",
  });
  const dir = await cacheDir(repo.root);
  assert.equal(existsSync(dir), false);

  const again = recorder();
  await read(repo.view, { runner: again.runner, redraft: true });
  assert.equal(again.prompts.length, 1);
  assert.equal((await descriptionStatus(repo.view)).status, "done");

  const replaced = recorder({ answer: { ...ANSWER, what: "Read again." } });
  await read(repo.view, { runner: replaced.runner, redraft: true });
  const done = await descriptionStatus(repo.view);
  assert.equal(done.status === "done" && done.description.what, "Read again.");
  assert.equal(done.status === "done" && done.error, undefined);
});

test("a failed Describe again keeps the earlier description, with why it failed, until a read succeeds", async () => {
  const repo = shopRepo();
  await read(repo.view, { runner: recorder().runner });
  await read(repo.view, {
    runner: recorder({ fail: "Claude Code failed: blocked" }).runner,
    redraft: true,
  });
  const kept = await descriptionStatus(repo.view);
  assert.equal(kept.status, "done");
  assert.equal(kept.status === "done" && kept.description.what, ANSWER.what);
  assert.equal(
    kept.status === "done" && kept.error,
    "Claude Code failed: blocked",
  );

  const again = recorder({ answer: { ...ANSWER, what: "Read again." } });
  await read(repo.view, { runner: again.runner, redraft: true });
  const done = await descriptionStatus(repo.view);
  assert.equal(done.status === "done" && done.description.what, "Read again.");
  assert.equal(done.status === "done" && done.error, undefined);
});

test("a provider that isn't installed, or is logged out, says so and reads nothing", async () => {
  const repo = shopRepo();
  for (const [status, reason] of [
    ["missing", "no-claude"],
    ["logged-out", "logged-out"],
  ] as const) {
    const ai = recorder();
    const started = await startDescription(repo.view, {
      runner: ai.runner,
      status: async () => status,
    });
    assert.deepEqual(started, {
      status: "unavailable",
      provider: "Claude Code",
      reason,
    });
    assert.deepEqual(
      await descriptionStatus(repo.view, async () => status),
      started,
    );
    assert.equal(ai.prompts.length, 0);
  }
  assert.equal((await descriptionStatus(repo.view, ready)).status, "idle");
  assert.equal(existsSync(await cacheDir(repo.root)), false);
});

test("opening a view starts its read when the repo reads automatically, and waits for a click when it doesn't", async () => {
  const repo = shopRepo();
  assert.equal(startsByItself(await descriptionStatus(repo.view)), true);

  await setAutoRead(repo.root, false);
  const idle = await descriptionStatus(repo.view);
  assert.deepEqual(idle, {
    status: "idle",
    provider: "Claude Code",
    auto: false,
  });
  assert.equal(startsByItself(idle), false);

  const ai = recorder();
  await read(repo.view, { runner: ai.runner });
  assert.equal(ai.prompts.length, 1);
  assert.equal(startsByItself(await descriptionStatus(repo.view)), false);
  assert.equal(startsByItself({ status: "none" }), false);
});

test("a patch past the cap is cut, with a summary of every file, and the prompt says so", async () => {
  const repo = shopRepo();
  const head = repo.commit(
    {
      "big.txt": `${"x".repeat(99)}\n`.repeat(5000),
      "src/sync/queue.ts": "export const queue = [];\n",
    },
    "Add a big file",
  );
  const view = { root: repo.root, base: repo.head, head };
  const ai = recorder();
  await read(view, { runner: ai.runner });

  const prompt = ai.prompts[0];
  assert.match(prompt, /The patch is too large to send whole/);
  assert.match(prompt, /big\.txt\s+\|\s+5000 \+/);
  assert.match(prompt, /src\/sync\/queue\.ts\s+\|/);
  assert.ok(Buffer.byteLength(prompt) < MAX_PATCH_BYTES + 20_000);
});

test("a patch past the cap is cut at a line end, never inside a character", async () => {
  const repo = shopRepo();
  const head = repo.commit(
    { "prices.txt": `${"€".repeat(100)}\n`.repeat(2000) },
    "Add prices",
  );
  const ai = recorder();
  await read({ root: repo.root, base: repo.head, head }, { runner: ai.runner });

  const prompt = ai.prompts[0];
  assert.match(prompt, /The patch is too large to send whole/);
  assert.ok(!prompt.includes("�"));
  assert.ok(prompt.endsWith(`+${"€".repeat(100)}\n`));
});
