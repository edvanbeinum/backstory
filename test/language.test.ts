import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { field, list, readText, root, entries as yamlEntries } from "./yaml";

const FILE = "architecture/language.yaml";
const text = readText(FILE);
const entries = (key: string) => yamlEntries(text, key);

test("the language file has terms, blocks and invariants, and AGENTS.md points at it", () => {
  for (const key of ["terms", "blocks", "invariants"]) {
    assert.ok(entries(key).length > 0, `${key} is empty`);
  }
  const agents = readText("AGENTS.md");
  assert.ok(agents.includes(FILE), `AGENTS.md doesn't name ${FILE}`);
});

test("every block's code paths exist", () => {
  for (const block of entries("blocks")) {
    const name = field(block, "name");
    const paths = list(block, "code");
    assert.ok(paths, `${name} has no code:`);
    assert.ok(paths.length > 0, `${name} lists no code`);
    for (const p of paths) {
      assert.ok(existsSync(path.join(root, p)), `${name}: ${p} doesn't exist`);
    }
  }
});

test("every file a term names exists", () => {
  for (const term of entries("terms")) {
    const means = field(term, "means") ?? "";
    for (const [, p] of means.matchAll(/`((?:lib|app|components)\/[^`]+)`/g)) {
      assert.ok(
        existsSync(path.join(root, p)),
        `${field(term, "name")}: ${p} doesn't exist`,
      );
    }
  }
});

test("every invariant has a rule", () => {
  for (const inv of entries("invariants")) {
    assert.ok(field(inv, "rule"), `an invariant has no rule: ${inv[0]}`);
  }
});

test("no thing has two term names", () => {
  const terms = entries("terms");
  const names = terms.map((t) => field(t, "name"));
  assert.ok(names.every(Boolean), "a term has no name");
  assert.equal(new Set(names).size, names.length, `duplicate term name`);
  // A drawing word given its own term is the flow/sequence clash this file
  // was written to end: one thing under two names.
  for (const t of terms) {
    const drawing = field(t, "drawing");
    if (drawing) {
      assert.ok(
        !names.includes(drawing),
        `${field(t, "name")}'s drawing "${drawing}" is also a term`,
      );
    }
  }
});
