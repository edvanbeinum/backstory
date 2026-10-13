import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { withToolDirs } from "../lib/exec";

const TOOL_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(homedir(), ".local", "bin"),
];

test("the tool directories join PATH after its own entries, whether or not they exist yet", () => {
  assert.deepEqual(withToolDirs("/usr/bin:/bin").split(":"), [
    "/usr/bin",
    "/bin",
    ...TOOL_DIRS,
  ]);
});

test("a tool directory already on PATH isn't added twice", () => {
  assert.deepEqual(withToolDirs("/usr/local/bin:/usr/bin").split(":"), [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    path.join(homedir(), ".local", "bin"),
  ]);
});
