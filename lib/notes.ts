import type { DatabaseSync } from "node:sqlite";

import { BRANCH_REV, WORKING_REV } from "./constants";
import {
  isObject,
  isTime,
  KEY,
  reading,
  transaction,
  type Legacy,
} from "./store";
import type { Note } from "./types";

/**
 * Notes on uncommitted work, per checkout: the `notes` table.
 *
 * Keyed by the worktree's root rather than a PR: uncommitted changes belong
 * to one directory on disk, often before any PR exists, and two worktrees of
 * the same repo are two different pieces of work.
 *
 * A note starts as a draft, becomes part of a round when it's handed over,
 * and is then yours to tick off once you've seen it dealt with.
 */

const MAX_BODY = 20_000;
const MAX_QUOTE = 2_000;
const MAX_PATH = 1_000;

const isTimeOrNull = (value: unknown) => value === null || isTime(value);

const isRev = (value: unknown) =>
  value === WORKING_REV ||
  value === BRANCH_REV ||
  (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));

/**
 * Checks a note from the window, and one from the old `notes.json`. Fields
 * added since the first notes may be absent there: no round or tick means a
 * draft, and no rev means uncommitted work, the only place notes could once
 * go.
 */
function isStoredNote(value: unknown): value is Note {
  if (!isObject(value)) return false;
  const n = value;
  return (
    typeof n.id === "string" &&
    (n.rev === undefined || isRev(n.rev)) &&
    (n.path === null ||
      (typeof n.path === "string" && n.path.length <= MAX_PATH)) &&
    (n.side === "old" || n.side === "new") &&
    (n.line === null ||
      (Number.isSafeInteger(n.line) && (n.line as number) > 0)) &&
    (n.quote === null ||
      (typeof n.quote === "string" && n.quote.length <= MAX_QUOTE)) &&
    typeof n.body === "string" &&
    n.body.length <= MAX_BODY &&
    isTime(n.createdAt) &&
    (n.sentAt === undefined || isTimeOrNull(n.sentAt)) &&
    (n.done === undefined || typeof n.done === "boolean") &&
    (n.doneAt === undefined || isTimeOrNull(n.doneAt))
  );
}

function normalize(note: Note): Note {
  const sentAt = note.sentAt ?? null;
  // A draft can't be handled; there's nothing yet to have handled it.
  const done = sentAt !== null && note.done === true;
  return {
    ...note,
    rev: note.rev ?? WORKING_REV,
    sentAt,
    done,
    doneAt: done ? (note.doneAt ?? null) : null,
  };
}

interface NoteRow {
  id: string;
  rev: string;
  path: string | null;
  side: "old" | "new";
  line: number | null;
  quote: string | null;
  body: string;
  created_at: number;
  sent_at: number | null;
  done: number;
  done_at: number | null;
}

/** Oldest first, which is the order you wrote them in. */
function read(database: DatabaseSync, root: string): Note[] {
  const rows = database
    .prepare(
      `SELECT id, rev, path, side, line, quote, body, created_at, sent_at, done, done_at
       FROM notes WHERE root = ? ORDER BY created_at, id`,
    )
    .all(root) as unknown as NoteRow[];
  return rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    path: row.path,
    side: row.side,
    line: row.line,
    quote: row.quote,
    body: row.body,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    done: row.done === 1,
    doneAt: row.done_at,
  }));
}

function insert(database: DatabaseSync, root: string, note: Note): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO notes
         (root, id, rev, path, side, line, quote, body, created_at, sent_at, done, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      root,
      note.id,
      note.rev,
      note.path,
      note.side,
      note.line,
      note.quote,
      note.body,
      note.createdAt,
      note.sentAt,
      note.done ? 1 : 0,
      note.doneAt,
    );
}

export async function getNotes(root: string): Promise<Note[]> {
  return reading([], (database) => read(database, root));
}

export type NotesChange =
  /** Add a draft, or edit one's text */
  | { op: "save"; note: Note }
  | { op: "remove"; id: string }
  /** Hand these drafts over as one round */
  | { op: "send"; ids: string[]; at: number }
  /** A queued round withdrawn before any agent took it: drafts again */
  | { op: "unsend"; ids: string[] }
  | { op: "tick"; id: string; done: boolean }
  | { op: "clearDrafts" }
  /** Forget every sent note you've ticked */
  | { op: "clearDone" };

const isId = (value: unknown): value is string =>
  typeof value === "string" && KEY.test(value);

/**
 * A change as it arrives over the wire, checked. Throws an "Invalid …" error
 * — which the route turns into a 400 — rather than returning a partial one.
 */
export function parseChange(body: unknown): NotesChange {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (b.op) {
    case "save": {
      const note = b.note as Note;
      if (!isStoredNote(note) || !isId(note.id))
        throw new Error("Invalid note");
      if (!note.body.trim()) throw new Error("Invalid note: empty");
      return { op: "save", note };
    }
    case "remove":
      if (!isId(b.id)) throw new Error("Invalid note id");
      return { op: "remove", id: b.id };
    case "send":
      if (!Array.isArray(b.ids) || !b.ids.every(isId))
        throw new Error("Invalid note id");
      if (!isTime(b.at)) throw new Error("Invalid send time");
      return { op: "send", ids: b.ids, at: b.at };
    case "unsend":
      if (!Array.isArray(b.ids) || !b.ids.every(isId))
        throw new Error("Invalid note id");
      return { op: "unsend", ids: b.ids };
    case "tick":
      if (!isId(b.id)) throw new Error("Invalid note id");
      if (typeof b.done !== "boolean") throw new Error("Invalid tick");
      return { op: "tick", id: b.id, done: b.done };
    case "clearDrafts":
    case "clearDone":
      return { op: b.op };
    default:
      throw new Error("Invalid change: unknown op");
  }
}

/**
 * The only mutator, synchronous so the outbox can make it part of its own
 * transaction. Returns the checkout's notes after the change.
 */
export function writeNotes(root: string, input: NotesChange): Note[] {
  // Checked here too, not only at the route: this is the one door to the table.
  const change = parseChange(input);

  return transaction((database) => {
    switch (change.op) {
      case "save": {
        const prior = database
          .prepare(
            "SELECT created_at, sent_at FROM notes WHERE root = ? AND id = ?",
          )
          .get(root, change.note.id) as
          { created_at: number; sent_at: number | null } | undefined;
        // Only a draft's words can change: a sent note is what the agent read.
        if (prior && prior.sent_at !== null)
          throw new Error("Invalid edit: already sent");
        insert(
          database,
          root,
          normalize({
            ...change.note,
            // An edit changes what you said, not when you first said it.
            createdAt: prior?.created_at ?? change.note.createdAt,
            sentAt: null,
            done: false,
          }),
        );
        break;
      }
      case "remove":
        database
          .prepare("DELETE FROM notes WHERE root = ? AND id = ?")
          .run(root, change.id);
        break;
      case "send":
        database
          .prepare(
            `UPDATE notes SET sent_at = ?
             WHERE root = ? AND sent_at IS NULL
               AND id IN (SELECT value FROM json_each(?))`,
          )
          .run(change.at, root, JSON.stringify(change.ids));
        break;
      case "unsend":
        database
          .prepare(
            `UPDATE notes SET sent_at = NULL, done = 0, done_at = NULL
             WHERE root = ? AND sent_at IS NOT NULL
               AND id IN (SELECT value FROM json_each(?))`,
          )
          .run(root, JSON.stringify(change.ids));
        break;
      case "tick":
        // Stamp `done_at` only on the transition, so re-ticking doesn't reset it.
        database
          .prepare(
            `UPDATE notes
             SET done_at = CASE WHEN ? = 0 THEN NULL WHEN done = 1 THEN done_at ELSE ? END,
                 done = ?
             WHERE root = ? AND id = ? AND sent_at IS NOT NULL`,
          )
          .run(
            change.done ? 1 : 0,
            Date.now(),
            change.done ? 1 : 0,
            root,
            change.id,
          );
        break;
      case "clearDrafts":
        database
          .prepare("DELETE FROM notes WHERE root = ? AND sent_at IS NULL")
          .run(root);
        break;
      case "clearDone":
        database
          .prepare("DELETE FROM notes WHERE root = ? AND done = 1")
          .run(root);
        break;
    }
    return read(database, root);
  });
}

export async function changeNotes(
  root: string,
  input: NotesChange,
): Promise<Note[]> {
  return writeNotes(root, input);
}

/** Copy the old `notes.json` in, skipping any note that doesn't check out. */
export function importNotes(database: DatabaseSync, legacy: Legacy): void {
  for (const [root, entries] of Object.entries(legacy)) {
    for (const value of Object.values(entries)) {
      if (isStoredNote(value) && isId(value.id))
        insert(database, root, normalize(value));
    }
  }
}
