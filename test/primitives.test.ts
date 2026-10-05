import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { entries, field, list, readText, root } from "./yaml";

const FILE = "architecture/primitives.yaml";
const primitives = entries(readText(FILE), "primitives");
const language = readText("architecture/language.yaml");
const blocks = entries(language, "blocks").map((b) => field(b, "name"));

test("the primitives file is filled in, and AGENTS.md points at it", () => {
  const agents = readText("AGENTS.md");
  assert.ok(agents.includes(FILE), `AGENTS.md doesn't name ${FILE}`);
  assert.ok(primitives.length > 0, "no primitives");
  for (const p of primitives) {
    const name = field(p, "name");
    assert.ok(name, `a primitive has no name: ${p[0]}`);
    assert.ok(field(p, "file"), `${name} has no file`);
    assert.ok(list(p, "symbols")?.length, `${name} lists no symbols`);
    assert.ok(field(p, "use"), `${name} has no use`);
  }
});

test("every listed symbol is still exported from its file", () => {
  for (const p of primitives) {
    const name = field(p, "name");
    const file = field(p, "file") ?? "";
    assert.ok(
      existsSync(path.join(root, file)),
      `${name}: ${file} doesn't exist`,
    );
    const source = readText(file);
    for (const symbol of list(p, "symbols") ?? []) {
      const re = new RegExp(
        `^export (async )?(function|const|class) ${symbol}\\b`,
        "m",
      );
      assert.ok(
        re.test(source),
        `${name}: ${file} no longer exports ${symbol}; update ${FILE}`,
      );
    }
  }
});

test("every primitive's block is a block in language.yaml", () => {
  for (const p of primitives) {
    const block = field(p, "block");
    if (block) {
      assert.ok(
        blocks.includes(block),
        `${field(p, "name")}: no block named "${block}" in language.yaml`,
      );
    }
  }
});

test("no primitive name appears twice", () => {
  const names = primitives.map((p) => field(p, "name"));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate primitive names`);
});
