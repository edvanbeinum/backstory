import { mkdirSync, promises as fs, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { importNotes } from "./notes";
import { importOutbox } from "./outbox";

/**
 * The SQLite database behind notes, rounds and responses: `backstory.db` in
 * `homeDir`.
 *
 * One database, so a write that touches two kinds of record commits or fails
 * as one (Send files a round and marks its notes sent), and so the schema is
 * the one place a record's shape is defined. It is `node:sqlite`, from the
 * Node the Mac app bundles: no dependency, and nothing native for the
 * standalone bundle to trace.
 *
 * The flow cache, the data cache and local models stay files: each is written
 * whole and read by its key, and nothing writes two of them at once.
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

const FILE = "backstory.db";
const VERSION = 1;

const SCHEMA = `
  CREATE TABLE notes (
    root TEXT NOT NULL,
    id TEXT NOT NULL,
    rev TEXT NOT NULL,
    path TEXT,
    side TEXT NOT NULL CHECK (side IN ('old', 'new')),
    line INTEGER CHECK (line > 0),
    quote TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    done INTEGER NOT NULL CHECK (done IN (0, 1)),
    done_at INTEGER,
    CHECK (done = 0 OR sent_at IS NOT NULL),
    CHECK (done = 1 OR done_at IS NULL),
    PRIMARY KEY (root, id)
  );
  CREATE TABLE rounds (
    root TEXT NOT NULL,
    id TEXT NOT NULL,
    note_ids TEXT NOT NULL CHECK (json_valid(note_ids)),
    message TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    for_session TEXT,
    delivered_at INTEGER,
    delivered_to TEXT,
    claim_session TEXT,
    claim_until INTEGER,
    CHECK ((claim_session IS NULL) = (claim_until IS NULL)),
    PRIMARY KEY (root, id)
  );
  CREATE TABLE seen (
    root TEXT NOT NULL,
    session TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (root, session)
  );
  CREATE TABLE responses (
    pr TEXT NOT NULL,
    thread TEXT NOT NULL,
    done INTEGER NOT NULL CHECK (done IN (0, 1)),
    done_at INTEGER,
    reply TEXT,
    commits TEXT NOT NULL CHECK (json_valid(commits)),
    PRIMARY KEY (pr, thread)
  );
`;

let open: { file: string; database: DatabaseSync } | null = null;

/**
 * The open database, opened on first use and reopened when `homeDir` moves,
 * so a request that writes nothing never makes the directory.
 */
export function db(): DatabaseSync {
  const home = homeDir();
  const file = path.join(home, FILE);
  if (open?.file === file) return open.database;

  open?.database.close();
  open = null;
  mkdirSync(home, { recursive: true });

  // Loaded at run time rather than imported, so neither bundler has to know a
  // builtin this new; `getBuiltinModule` is a call they leave alone.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const database = new DatabaseSync(file);
  // A dev server and the Mac app can share a home: WAL lets one read while
  // the other writes, and the timeout makes a writer wait rather than fail.
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");

  let imported: string[] = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    const { user_version } = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (user_version === 0) {
      database.exec(SCHEMA);
      imported = importJson(database, home);
      database.exec(`PRAGMA user_version = ${VERSION}`);
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    database.close();
    throw err;
  }
  // Renamed, never deleted, so a user can put a file back by hand.
  for (const name of imported) renameSync(name, `${name}.migrated`);

  open = { file, database };
  return database;
}

/** A JSON store file as it was: `namespace -> key -> record`, unchecked. */
export type Legacy = Record<string, Record<string, unknown>>;

/**
 * Copy the JSON files this database replaced into a new database, in its
 * first transaction, and return the paths it read. Remove this, and the
 * importers it calls, in the release after the one that ships the database.
 */
function importJson(database: DatabaseSync, home: string): string[] {
  const importers: [string, (d: DatabaseSync, legacy: Legacy) => void][] = [
    ["notes.json", importNotes],
    ["outbox.json", importOutbox],
  ];
  const read: string[] = [];
  for (const [name, importer] of importers) {
    const file = path.join(home, name);
    const legacy = readLegacy(file);
    if (legacy === null) continue;
    importer(database, legacy);
    read.push(file);
  }
  return read;
}

/** Null when the file isn't there; a file that won't parse reads as empty. */
function readLegacy(file: string): Legacy | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!isObject(parsed)) return {};

  const out: Legacy = {};
  for (const [namespace, entries] of Object.entries(parsed)) {
    if (!isObject(entries)) continue;
    out[namespace] = Object.fromEntries(
      Object.entries(entries).filter(([key]) => KEY.test(key)),
    );
  }
  return out;
}

/**
 * Run `fn` inside one `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws.
 * Inside a transaction already, `fn` joins it, so one module's write can be
 * part of a larger one. `fn` must be synchronous: an `await` in it would let
 * the commit run before the work.
 */
export function transaction<T>(fn: (database: DatabaseSync) => T): T {
  const database = db();
  if (database.isTransaction) return fn(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
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
