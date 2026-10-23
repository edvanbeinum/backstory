import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BRANCH_REV, WORKING_REV } from "../lib/constants";
import { resolveRepo } from "../lib/git";
import { onBranchOnly, viewRange } from "../lib/view";

const root = mkdtempSync(path.join(os.tmpdir(), "backstory-view-"));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (...a: string[]) =>
  execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "T");
writeFileSync(path.join(root, "a.ts"), "one\n");
git("add", "-A");
git("commit", "-qm", "First");
const first = git("rev-parse", "HEAD");
writeFileSync(path.join(root, "a.ts"), "two\n");
git("commit", "-qam", "Second");
const second = git("rev-parse", "HEAD");

test("a commit's view runs from its first parent to the commit", async () => {
  const repo = await resolveRepo(root);
  assert.deepEqual(await viewRange(repo, second.slice(0, 7)), {
    base: first,
    head: second,
  });
});

test("a root commit's view has no base", async () => {
  const repo = await resolveRepo(root);
  assert.deepEqual(await viewRange(repo, first), { base: null, head: first });
});

test("uncommitted work and a rev that isn't a commit have no view", async () => {
  const repo = await resolveRepo(root);
  assert.equal(await viewRange(repo, WORKING_REV), null);
  assert.equal(await viewRange(repo, "no-such-branch"), null);
});

test("the whole branch runs to the tip of the branch the repo was opened with, else HEAD", async () => {
  const stack = mkdtempSync(path.join(os.tmpdir(), "backstory-view-stack-"));
  after(() => rmSync(stack, { recursive: true, force: true }));
  const sh = (...a: string[]) =>
    execFileSync("git", ["-C", stack, ...a], { encoding: "utf8" }).trim();
  const commit = (file: string, message: string) => {
    writeFileSync(path.join(stack, file), `${message}\n`);
    sh("add", "-A");
    sh("commit", "-qm", message);
    return sh("rev-parse", "HEAD");
  };
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "T");
  const fork = commit("base.ts", "Start");
  sh("checkout", "-qb", "side");
  const side = commit("side.ts", "Side");
  sh("checkout", "-q", "main");
  sh("checkout", "-qb", "checked");
  const checked = commit("checked.ts", "Checked out");

  assert.deepEqual(await viewRange(await resolveRepo(stack), BRANCH_REV), {
    base: fork,
    head: checked,
  });
  const reviewing = await resolveRepo(stack, "side");
  assert.deepEqual(await viewRange(reviewing, BRANCH_REV), {
    base: fork,
    head: side,
  });
  assert.deepEqual(await viewRange(reviewing, checked), {
    base: fork,
    head: checked,
  });

  assert.equal(await onBranchOnly(reviewing, side), true);
  assert.equal(await onBranchOnly(reviewing, fork), false);
  assert.equal(await onBranchOnly(reviewing, checked), false);
});
