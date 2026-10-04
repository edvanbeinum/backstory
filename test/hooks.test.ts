import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 * Git with none of Ed's config, and no GIT_* left over from a hook that is
 * running these tests, so it only ever sees the temp directory it's given.
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
  execFileSync("sh", ["-c", scripts.prepare], { cwd: dir, env: gitEnv(dir) });
}

test("npm install points git at the repo's hooks, and pre-push runs the check", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "differ-prepare-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv(repo) });
    prepare(repo);
    const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
      cwd: repo,
      env: gitEnv(repo),
      encoding: "utf8",
    }).trim();
    assert.equal(hooksPath, ".githooks");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // The mode git records is what every clone, worktree and CI checkout gets.
  const entry = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "-s", "--", ".githooks/pre-push"],
    { encoding: "utf8" },
  );
  assert.match(entry, /^100755 /);
  const hook = readFileSync(path.join(ROOT, ".githooks", "pre-push"), "utf8");
  assert.match(hook, /^\s*if ! npm run check; then/m);
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
