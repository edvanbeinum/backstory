import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Read as text, not parsed: nothing else in Backstory needs a YAML dependency,
// and these checks only rely on a few line shapes.
export const root = path.join(__dirname, "..");

export function readText(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

export function section(text: string, key: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `no top-level ${key}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

export function entries(text: string, key: string): string[][] {
  const out: string[][] = [];
  for (const line of section(text, key)) {
    if (line.startsWith("  - ")) out.push([line]);
    else if (out.length) out[out.length - 1].push(line);
  }
  return out;
}

export function field(entry: string[], name: string): string | undefined {
  const re = new RegExp(`^(?:  - |    )${name}: (.+)$`);
  for (const line of entry) {
    const m = re.exec(line);
    if (m) return m[1];
  }
}

export function list(entry: string[], name: string): string[] | undefined {
  const at = entry.indexOf(`    ${name}:`);
  if (at === -1) return undefined;
  const items: string[] = [];
  for (const line of entry.slice(at + 1)) {
    const m = /^      - (.+)$/.exec(line);
    if (!m) break;
    items.push(m[1]);
  }
  return items;
}
