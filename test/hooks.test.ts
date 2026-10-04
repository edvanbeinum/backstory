import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const scripts: Record<string, string> = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
).scripts;

/**
 * Strip the user's git config and any GIT_* a pre-push hook exported, so git
 * sees only the temp directory it's given.
 */
function gitEnv(dir: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  return env;
}

function prepare(dir: string) {
  const run = spawnSync("sh", ["-c", scripts.prepare], {
    cwd: dir,
    env: gitEnv(dir),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stderr;
}

function hooksPath(repo: string) {
  return execFileSync("git", ["config", "core.hooksPath"], {
    cwd: repo,
    env: gitEnv(repo),
    encoding: "utf8",
  }).trim();
}

test("npm install points git at the repo's hooks, and pre-push runs the check", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "differ-prepare-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv(repo) });
    assert.equal(prepare(repo), "");
    assert.equal(hooksPath(repo), ".githooks");
    assert.equal(prepare(repo), "", "a second install is silent");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // Check git's recorded mode, not the disk: it's what every clone, worktree
  // and CI checkout gets.
  const entry = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "-s", "--", ".githooks/pre-push"],
    { encoding: "utf8" },
  );
  assert.match(entry, /^100755 /);
  const hook = readFileSync(path.join(ROOT, ".githooks", "pre-push"), "utf8");
  assert.match(hook, /^\s*if ! npm run check; then/m);
});

test("npm install leaves a hooks path the user set, and says the hook isn't installed", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "differ-prepare-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv(repo) });
    execFileSync("git", ["config", "core.hooksPath", ".husky"], {
      cwd: repo,
      env: gitEnv(repo),
    });
    assert.match(prepare(repo), /already \.husky.*isn't installed/);
    assert.equal(hooksPath(repo), ".husky");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("outside a git repo, npm install's prepare does nothing and succeeds", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "differ-tarball-"));
  try {
    prepare(dir);
    assert.equal(existsSync(path.join(dir, ".git")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tests never see the real store", () => {
  const home = process.env.DIFFER_HOME;
  assert.ok(home, "npm test sets DIFFER_HOME");
  assert.notEqual(path.resolve(home), path.join(os.homedir(), ".differ"));
  // macOS reaches its temp dir through the /var -> /private/var symlink.
  const tmp = realpathSync(os.tmpdir());
  assert.ok(
    realpathSync(home).startsWith(tmp + path.sep),
    `${home} is inside ${tmp}`,
  );
});

test("verify is the one definition of OK, and CI runs it", () => {
  assert.match(scripts.verify, /npm run check/);
  assert.match(scripts.verify, /npm run build/);

  const workflow = readFileSync(
    path.join(ROOT, ".github", "workflows", "check.yml"),
    "utf8",
  );
  assert.match(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*push:\s*\n\s*branches:\s*\[main\]/m);
  assert.match(workflow, /run: npm ci$/m);
  assert.match(workflow, /run: npm run verify$/m);
});
