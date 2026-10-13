import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loginShellDirs, withToolDirs } from "../lib/exec";
import { standIns } from "./standins";

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

const shell = (body: string) => path.join(standIns({ zsh: body }), "zsh");
const TOOLS = ["gh", "claude"];

test("the login shell's folder for a tool joins PATH, and its other output is ignored", async () => {
  const dirs = await loginShellDirs(
    shell(
      'echo "Welcome back"\necho /x/nvm/bin/claude\necho /etc/motd\necho "gh not found"',
    ),
    TOOLS,
    2_000,
  );
  assert.deepEqual(dirs, ["/x/nvm/bin"]);
});

test("a login shell that hangs finds nothing, within the timeout", async () => {
  const started = Date.now();
  const dirs = await loginShellDirs(shell("sleep 10"), TOOLS, 300);
  assert.deepEqual(dirs, []);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("a login shell that fails finds nothing", async () => {
  assert.deepEqual(await loginShellDirs(shell("exit 1"), TOOLS, 2_000), []);
});

test("an alias is not a folder", async () => {
  assert.deepEqual(
    await loginShellDirs(
      shell('echo "claude: aliased to /x/bin/claude --yolo"'),
      TOOLS,
      2_000,
    ),
    [],
  );
});
