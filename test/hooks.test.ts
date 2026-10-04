import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const scripts: Record<string, string> = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
).scripts;

test("the committed pre-push hook is executable and runs the check", () => {
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
