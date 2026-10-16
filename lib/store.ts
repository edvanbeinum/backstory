import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { importNotes } from "./notes";
import { importOutbox } from "./outbox";
import { importResponses } from "./responses";

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
 *
 * A new database imports the JSON files it replaced (`importJson`). Remove the
 * import in the release after the one that ships the database.
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
 * The open database, opened on first use rather than at import, so a request
 * that never reaches the store makes nothing on disk; reopened when `homeDir`
 * moves.
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
  open = { file, database };
  // Rename, never delete, so a user can put a file back by hand. A file that
  // won't rename is left where it is: the import has committed, and a
  // database at this version never reads the files again.
  for (const name of imported) {
    try {
      renameSync(name, `${name}.migrated`);
    } catch (err) {
      console.error(`Backstory couldn't rename ${name}:`, err);
    }
  }
  return database;
}

/** A JSON store file as it was: `namespace -> key -> record`, unchecked. */
export type Legacy = Record<string, Record<string, unknown>>;

/** A JSON object, as opposed to an array, null or a scalar. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Copy the JSON files this database replaced into a new database, in its
 * first transaction, and return the paths it read.
 */
function importJson(database: DatabaseSync, home: string): string[] {
  const importers: [string, (d: DatabaseSync, legacy: Legacy) => void][] = [
    ["notes.json", importNotes],
    ["outbox.json", importOutbox],
    ["responses.json", importResponses],
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

/**
 * Run a read, or log why it failed and return `empty`. The store records
 * what you've done; a database that won't open shows none of that rather than
 * taking down the inbox or the diff it sits beside.
 */
export function reading<T>(empty: T, fn: (database: DatabaseSync) => T): T {
  try {
    return fn(db());
  } catch (err) {
    console.error("Backstory couldn't read its database:", err);
    return empty;
  }
}

/** GitHub thread node ids are opaque base64-ish strings; be strict anyway. */
export const KEY = /^[A-Za-z0-9_=-]{1,200}$/;
