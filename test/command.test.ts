import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");

/**
 * Lays out the Mac app's bundle the way `mac/build.sh` does, with the Node
 * running this test standing in for the bundled one.
 */
function buildBundle(app: string) {
  const bin = path.join(app, "Contents", "Resources", "bin");
  const claude = path.join(app, "Contents", "Resources", "packaging", "claude");
  mkdirSync(path.join(app, "Contents", "Helpers"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(claude, { recursive: true });
  symlinkSync(process.execPath, path.join(app, "Contents", "Helpers", "node"));
  for (const file of [
    "backstory.mjs",
    "hook.mjs",
    "macapp.mjs",
    "claude-setup.mjs",
  ])
    copyFileSync(path.join(root, "bin", file), path.join(bin, file));
  copyFileSync(
    path.join(root, "mac", "bin", "backstory"),
    path.join(bin, "backstory"),
  );
  chmodSync(path.join(bin, "backstory"), 0o755);
  copyFileSync(
    path.join(root, "packaging", "claude", "backstory-review.md"),
    path.join(claude, "backstory-review.md"),
  );
}

function backstory(link: string, args: string[], input = "") {
  return execFileSync(link, args, {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "backstory-cc-")),
    },
  });
}

test("the bundled command runs through a link, and still does after the app is replaced", () => {
  const app = path.join(
    mkdtempSync(path.join(os.tmpdir(), "backstory app ")),
    "Backstory.app",
  );
  buildBundle(app);
  const link = path.join(
    mkdtempSync(path.join(os.tmpdir(), "backstory-link-")),
    "backstory",
  );
  symlinkSync(
    path.join(app, "Contents", "Resources", "bin", "backstory"),
    link,
  );

  assert.match(backstory(link, ["--help"]), /usage: backstory/);
  assert.equal(backstory(link, ["hook", "stop"], "{}"), "");
  const plan = JSON.parse(backstory(link, ["setup", "claude", "--check"]));
  assert.equal(plan.state, "none");
  assert.ok(plan.command.includes(`${app}/Contents/Resources/bin/backstory`));

  rmSync(app, { recursive: true });
  buildBundle(app);
  assert.match(backstory(link, ["--help"]), /usage: backstory/);
});
