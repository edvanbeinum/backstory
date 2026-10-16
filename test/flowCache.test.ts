import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  flowsStatus,
  onFlowsChange,
  startFlows,
  type View,
} from "../lib/flows/cache";
import { repoKey } from "../lib/git";

process.env.BACKSTORY_HOME = mkdtempSync(
  path.join(os.tmpdir(), "backstory-home-"),
);

const temps: string[] = [process.env.BACKSTORY_HOME];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const ready = async () => "ready" as const;

/**
 * A repo whose second commit changes only `architecture/`, which is never
 * app code, so a run finishes with no flows and never calls the AI provider.
 */
function modelOnlyRepo(): View {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-flow-cache-"));
  temps.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "--allow-empty", "-qm", "Start");
  const base = git("rev-parse", "HEAD");
  mkdirSync(path.join(root, "architecture"));
  writeFileSync(path.join(root, "architecture/notes.md"), "model\n");
  git("add", "-A");
  git("commit", "-qm", "Describe the model");
  return { root, base, head: git("rev-parse", "HEAD") };
}

/** Resolves on the next change event for this root, once a run ends. */
function settled(root: string): Promise<void> {
  return new Promise((resolve) => {
    const off = onFlowsChange((changed) => {
      if (changed !== root) return;
      off();
      resolve();
    });
  });
}

test("a missing or logged-out provider starts no run and leaves the view idle", async () => {
  const view = modelOnlyRepo();
  assert.deepEqual(await startFlows(view, { status: async () => "missing" }), {
    status: "unavailable",
    reason: "no-claude",
  });
  assert.deepEqual(
    await startFlows(view, { status: async () => "logged-out" }),
    { status: "unavailable", reason: "logged-out" },
  );
  assert.deepEqual(await flowsStatus(view), { status: "idle" });
});

test("a run goes from running to ready and caches its flows, so the next start runs nothing", async () => {
  const view = modelOnlyRepo();
  const done = settled(view.root);
  const started = await startFlows(view, { status: ready });
  assert.equal(started.status, "running");
  await done;

  const status = await flowsStatus(view);
  assert.equal(status.status, "ready");
  assert.ok(status.status === "ready");
  assert.deepEqual(status.flows.flows, []);
  assert.equal(status.runError, undefined);
  assert.deepEqual(
    readdirSync(
      path.join(process.env.BACKSTORY_HOME!, "flows", await repoKey(view.root)),
    ),
    [`${view.base}..${view.head}.sarif.json`],
  );

  assert.equal((await startFlows(view, { status: ready })).status, "ready");
});

test("a run that throws fails with its message, and the next start clears it", async () => {
  const view = { ...modelOnlyRepo(), head: "0".repeat(40) };
  const done = settled(view.root);
  await startFlows(view, { status: ready });
  await done;

  const failed = await flowsStatus(view);
  assert.equal(failed.status, "failed");
  assert.ok(failed.status === "failed" && failed.error.length > 0);

  const again = settled(view.root);
  assert.equal((await startFlows(view, { status: ready })).status, "running");
  await again;
});

test("a failed regenerate keeps the cached flows and reports the run's error beside them", async () => {
  const view = modelOnlyRepo();
  const first = settled(view.root);
  await startFlows(view, { status: ready });
  await first;

  // Give a head that isn't a commit the cached flows, so regenerating it fails.
  const dir = path.join(
    process.env.BACKSTORY_HOME!,
    "flows",
    await repoKey(view.root),
  );
  const broken = { ...view, head: "f".repeat(40) };
  copyFileSync(
    path.join(dir, `${view.base}..${view.head}.sarif.json`),
    path.join(dir, `${view.base}..${broken.head}.sarif.json`),
  );

  const done = settled(view.root);
  await startFlows(broken, { status: ready, regenerate: true });
  await done;

  const status = await flowsStatus(broken);
  assert.equal(status.status, "ready");
  assert.ok(status.status === "ready" && (status.runError ?? "").length > 0);
});
