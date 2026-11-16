import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { browse, listWorktrees } from "../lib/browse";

// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Resolve the temp folder's symlinks (macOS's /var), since git reports
// worktree paths resolved.
const scratch = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "backstory-browse-")),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "First");
}

test("lists a repo's worktrees, the current one first, then by name", async () => {
  const dir = path.join(scratch, "worktrees");
  const main = path.join(dir, "main");
  repo(main);
  run(main, "worktree", "add", "-q", "-b", "feature/z", path.join(dir, "zed"));
  run(main, "worktree", "add", "-q", "-b", "feature/a", path.join(dir, "ant"));
  run(main, "worktree", "add", "-q", "--detach", path.join(dir, "loose"));
  const head = run(main, "rev-parse", "HEAD");

  const worktrees = await listWorktrees(path.join(dir, "zed"));

  assert.deepEqual(
    worktrees.map((w) => [w.name, w.branch, w.isCurrent]),
    [
      ["zed", "feature/z", true],
      ["ant", "feature/a", false],
      ["loose", null, false],
      ["main", "main", false],
    ],
  );
  assert.ok(worktrees.every((w) => w.head === head));
  assert.ok(worktrees.every((w) => !w.missing));
});

test("marks a worktree whose folder is gone as missing", async () => {
  const dir = path.join(scratch, "missing");
  const main = path.join(dir, "main");
  repo(main);
  const gone = path.join(dir, "gone");
  run(main, "worktree", "add", "-q", "-b", "gone", gone);
  rmSync(gone, { recursive: true, force: true });

  const worktrees = await listWorktrees(main);

  assert.deepEqual(
    worktrees.map((w) => [w.name, w.isCurrent, w.missing ?? false]),
    [
      ["main", true, false],
      ["gone", false, true],
    ],
  );
});

test("lists no worktrees outside a repo", async () => {
  const dir = path.join(scratch, "plain");
  mkdirSync(dir);
  assert.deepEqual(await listWorktrees(dir), []);
});

test("lists a folder's directories, flags checkouts, skips the noise and puts dotfiles last", async () => {
  const dir = path.join(scratch, "browse");
  repo(path.join(dir, "app"));
  mkdirSync(path.join(dir, "notes"));
  mkdirSync(path.join(dir, ".config"));
  mkdirSync(path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "readme.txt"), "not a folder\n");

  const result = await browse(dir);

  assert.equal(result.path, dir);
  assert.equal(result.parent, scratch);
  assert.deepEqual(
    result.entries.map((e) => [e.name, e.path, e.isRepo]),
    [
      ["app", path.join(dir, "app"), true],
      ["notes", path.join(dir, "notes"), false],
      [".config", path.join(dir, ".config"), false],
    ],
  );
  assert.deepEqual(result.worktrees, []);
});

test("lists the current repo's worktrees beside the folder", async () => {
  const dir = path.join(scratch, "browse-repo");
  const main = path.join(dir, "main");
  repo(main);

  const result = await browse(dir, main);

  assert.deepEqual(
    result.worktrees.map((w) => [w.path, w.isCurrent]),
    [[main, true]],
  );
});

test("reports a folder it can't read as empty, and the root as having no parent", async () => {
  const unreadable = await browse(path.join(scratch, "no-such-folder"));
  assert.deepEqual(unreadable.entries, []);

  const root = await browse("/");
  assert.equal(root.parent, null);
});
