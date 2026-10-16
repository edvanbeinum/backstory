import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { db, homeDir } from "../lib/store";

/**
 * Every case points BACKSTORY_HOME into a fresh temp directory, so nothing is
 * ever written to the real home.
 */
const previousHome = process.env.BACKSTORY_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
  else process.env.BACKSTORY_HOME = previousHome;
});

test("the directory and the database are made on the first open", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-home-test-"));
  const home = path.join(dir, ".backstory");
  process.env.BACKSTORY_HOME = home;

  assert.equal(homeDir(), home);
  assert.equal(existsSync(home), false);
  db();
  assert.ok(existsSync(path.join(home, "backstory.db")));
});

test("BACKSTORY_HOME is used as given, whatever it's called", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-home-test-"));
  const home = path.join(dir, "elsewhere");
  process.env.BACKSTORY_HOME = home;
  assert.equal(homeDir(), home);
});
