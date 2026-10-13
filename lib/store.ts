import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The tiny JSON store behind pins and drafts.
 *
 * Deliberately not a database: the whole thing is a few KB of click-driven
 * writes with no queries. Keeping it as plain JSON means no dependency, no
 * native build to complicate the standalone bundle in the Mac app, and a
 * file you can `cat`, hand-edit or `rm` — which is a real feature in a
 * local dev tool.
 *
 * Everything goes through this module so that if the data ever does outgrow
 * a file (relational shape, or writes on a timer rather than a click),
 * swapping in SQLite is a change here and nowhere else.
 */

/**
 * The directory everything on this machine lives in: BACKSTORY_HOME, else
 * `~/.backstory`. Resolved per call, not once at import, so a test can point
 * the store at a temp directory. Without that, testing the store would mean
 * writing to the real `~/.backstory` — which holds the only copy of your
 * drafts.
 */
export function homeDir(): string {
  return process.env.BACKSTORY_HOME || path.join(homedir(), ".backstory");
}

export function storePath(name: string): string {
  return path.join(homeDir(), `${name}.json`);
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

/**
 * Serialise everything that touches one store file.
 *
 * A store operation is read-modify-write, and two of them interleaved lose the
 * first writer's changes. That used to be impossible by accident — pins and
 * drafts lived in separate files, so their writers could never meet. Now that
 * one record holds the tick, the reply and the linked commit, a debounced
 * draft save and a tick click land on the same file, and the collision is
 * real.
 *
 * A promise chain is enough because there is exactly one local server process.
 * A rejection must not poison the chain, so the tail always settles.
 */
const queues = new Map<string, Promise<unknown>>();

export function withStore<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(name) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  queues.set(
    name,
    next.catch(() => {}),
  );
  return next;
}

/** Distinguishes concurrent writes within one process. */
let tmpCounter = 0;

export async function writeNamespaced<T>(
  name: string,
  data: Record<string, Record<string, T>>,
): Promise<void> {
  await fs.mkdir(homeDir(), { recursive: true });
  // Write-then-rename, so a crash mid-write can't truncate what's there.
  // The counter matters: with only the pid in the name, two overlapping
  // writes to one store share a temp path, and the loser can be renamed into
  // place half-written — the exact corruption rename is meant to prevent.
  const target = storePath(name);
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/** GitHub thread node ids are opaque base64-ish strings; be strict anyway. */
export const KEY = /^[A-Za-z0-9_=-]{1,200}$/;
