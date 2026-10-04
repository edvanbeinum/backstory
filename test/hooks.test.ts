import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
