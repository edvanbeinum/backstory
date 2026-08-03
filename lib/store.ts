import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The tiny JSON store behind pins and drafts.
 *
 * Deliberately not a database: the whole thing is a few KB of click-driven
 * writes with no queries. Keeping it as plain JSON means no dependency, no
 * native build to complicate the standalone bundle and Homebrew formula, and
 * a file you can `cat`, hand-edit or `rm` — which is a real feature in a
 * local dev tool.
 *
 * Everything goes through this module so that if the data ever does outgrow
 * a file (relational shape, or writes on a timer rather than a click),
 * swapping in SQLite is a change here and nowhere else.
 */

const DIR = path.join(homedir(), ".differ");

export function storePath(name: string): string {
  return path.join(DIR, `${name}.json`);
}

/**
 * Read a store file as `key -> record`, dropping anything that fails
 * validation. The file lives on disk and is meant to be hand-editable, so
 * it's re-validated on every read rather than trusted.
 */
export async function readNamespaced<T>(
  name: string,
  isValid: (value: unknown) => value is T,
): Promise<Record<string, Record<string, T>>> {
  try {
    const raw = await fs.readFile(storePath(name), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const out: Record<string, Record<string, T>> = {};
    for (const [namespace, entries] of Object.entries(parsed)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        continue;
      }
      const inner: Record<string, T> = {};
      for (const [key, value] of Object.entries(entries)) {
        if (KEY.test(key) && isValid(value)) inner[key] = value;
      }
      out[namespace] = inner;
    }
    return out;
  } catch {
    // Missing or unreadable — this store is a convenience, never load-bearing.
    return {};
  }
}

export async function writeNamespaced<T>(
  name: string,
  data: Record<string, Record<string, T>>,
): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  // Write-then-rename, so a crash mid-write can't truncate what's there.
  const target = storePath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/** GitHub thread node ids are opaque base64-ish strings; be strict anyway. */
export const KEY = /^[A-Za-z0-9_=-]{1,200}$/;
