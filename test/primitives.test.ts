import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Read as text, not parsed: nothing else in differ needs a YAML dependency,
// and these checks only rely on a few line shapes.
const root = path.join(__dirname, "..");
const FILE = "architecture/primitives.yaml";
const text = readFileSync(path.join(root, FILE), "utf8");

function section(key: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `no top-level ${key}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** One entry per `  - ` item: its own lines, item line first. */
function entries(key: string): string[][] {
  const out: string[][] = [];
  for (const line of section(key)) {
    if (line.startsWith("  - ")) out.push([line]);
    else if (out.length) out[out.length - 1].push(line);
  }
  return out;
}

function field(entry: string[], name: string): string | undefined {
  const re = new RegExp(`^(?:  - |    )${name}: (.+)$`);
  for (const line of entry) {
    const m = re.exec(line);
    if (m) return m[1];
  }
}

test("the primitives file has terms, blocks and invariants, and AGENTS.md points at it", () => {
  for (const key of ["terms", "blocks", "invariants"]) {
    assert.ok(entries(key).length > 0, `${key} is empty`);
  }
  const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(FILE), `AGENTS.md doesn't name ${FILE}`);
});

test("every block's code paths exist", () => {
  for (const block of entries("blocks")) {
    const name = field(block, "name");
    const at = block.indexOf("    code:");
    assert.notEqual(at, -1, `${name} has no code:`);
    const paths: string[] = [];
    for (const line of block.slice(at + 1)) {
      const m = /^      - (.+)$/.exec(line);
      if (!m) break;
      paths.push(m[1]);
    }
    assert.ok(paths.length > 0, `${name} lists no code`);
    for (const p of paths) {
      assert.ok(existsSync(path.join(root, p)), `${name}: ${p} doesn't exist`);
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
