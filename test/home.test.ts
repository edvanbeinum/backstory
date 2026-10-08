import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { homeDir, readNamespaced, writeNamespaced } from "../lib/store";

/**
 * Every case works beside a fresh temp directory and points BACKSTORY_HOME
 * into it, so the move is never tried on the real home.
 */
const previousHome = process.env.BACKSTORY_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
  else process.env.BACKSTORY_HOME = previousHome;
});

const isString = (value: unknown): value is string => typeof value === "string";

function beside(): { dir: string; old: string; home: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-home-test-"));
  const home = path.join(dir, ".backstory");
  process.env.BACKSTORY_HOME = home;
  return { dir, old: path.join(dir, ".differ"), home };
}

test("a store kept under the old name is read from the new one, and the old directory is gone", async () => {
  const { old, home } = beside();
  mkdirSync(old);
  writeFileSync(
    path.join(old, "notes.json"),
    JSON.stringify({ "/repos/app": { n1: "kept" } }),
  );

  assert.equal(homeDir(), home);
  assert.deepEqual(await readNamespaced("notes", isString), {
    "/repos/app": { n1: "kept" },
  });
  assert.equal(existsSync(old), false);
});

test("with the new directory already there, the old one is left as it is", async () => {
  const { old, home } = beside();
  mkdirSync(old);
  writeFileSync(path.join(old, "notes.json"), "{}");
  mkdirSync(home);

  assert.equal(homeDir(), home);
  assert.ok(existsSync(path.join(old, "notes.json")));
  assert.deepEqual(await readNamespaced("notes", isString), {});
});

test("with neither, the directory is made on the first write", async () => {
  const { home } = beside();

  assert.equal(homeDir(), home);
  assert.equal(existsSync(home), false);
  await writeNamespaced("notes", { "/repos/app": { n1: "new" } });
  assert.ok(existsSync(path.join(home, "notes.json")));
});

test("BACKSTORY_HOME is used as given, whatever it's called", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-home-test-"));
  const home = path.join(dir, "elsewhere");
  process.env.BACKSTORY_HOME = home;
  assert.equal(homeDir(), home);
});

test("the move is tried once per process: an old directory that turns up later stays put", () => {
  const { old, home } = beside();
  assert.equal(homeDir(), home);

  mkdirSync(old);
  assert.equal(homeDir(), home);
  assert.ok(existsSync(old));
  assert.equal(existsSync(home), false);
});
