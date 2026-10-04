import { BRANCH_REV, WORKING_REV } from "./constants";
import { KEY, readNamespaced, withStore, writeNamespaced } from "./store";
import type { Note } from "./types";

/**
 * Notes on uncommitted work, per checkout.
 *
 * Keyed by the worktree's root rather than a PR: uncommitted changes belong
 * to one directory on disk, often before any PR exists, and two worktrees of
 * the same repo are two different pieces of work.
 *
 * A note starts as a draft, becomes part of a round when it's handed over,
 * and is then yours to tick off once you've seen it dealt with.
 *
 * Shape: { "/abs/path/to/worktree": { "<noteId>": Note } }
 */

const NAME = "notes";

const MAX_BODY = 20_000;
const MAX_QUOTE = 2_000;
const MAX_PATH = 1_000;

const isTime = (value: unknown) => value === null || typeof value === "number";

const isRev = (value: unknown) =>
  value === WORKING_REV ||
  value === BRANCH_REV ||
  (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));

/**
 * The file is meant to be hand-editable, so nothing in it is trusted. Fields
 * added since the first notes may be absent: no round or tick means a draft,
 * and no rev means uncommitted work, the only place notes could once go.
 */
function isStoredNote(value: unknown): value is Note {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    (n.rev === undefined || isRev(n.rev)) &&
    (n.path === null || (typeof n.path === "string" && n.path.length <= MAX_PATH)) &&
    (n.side === "old" || n.side === "new") &&
    (n.line === null || (Number.isInteger(n.line) && (n.line as number) > 0)) &&
    (n.quote === null || (typeof n.quote === "string" && n.quote.length <= MAX_QUOTE)) &&
    typeof n.body === "string" &&
    n.body.length <= MAX_BODY &&
    typeof n.createdAt === "number" &&
    (n.sentAt === undefined || isTime(n.sentAt)) &&
    (n.done === undefined || typeof n.done === "boolean") &&
    (n.doneAt === undefined || isTime(n.doneAt))
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

/** Oldest first, which is the order you wrote them in. */
function sorted(notes: Record<string, Note>): Note[] {
  return Object.values(notes)
    .map(normalize)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getNotes(root: string): Promise<Note[]> {
  const store = await readNamespaced<Note>(NAME, isStoredNote);
  return sorted(store[root] ?? {});
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
      if (!isStoredNote(note) || !isId(note.id)) throw new Error("Invalid note");
      if (!note.body.trim()) throw new Error("Invalid note: empty");
      return { op: "save", note };
    }
    case "remove":
      if (!isId(b.id)) throw new Error("Invalid note id");
      return { op: "remove", id: b.id };
    case "send":
      if (!Array.isArray(b.ids) || !b.ids.every(isId)) throw new Error("Invalid note id");
      if (typeof b.at !== "number") throw new Error("Invalid send time");
      return { op: "send", ids: b.ids, at: b.at };
    case "unsend":
      if (!Array.isArray(b.ids) || !b.ids.every(isId)) throw new Error("Invalid note id");
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
 * The only mutator. Every change is a read-modify-write of the whole file, so
 * it runs under the store's lock, and a round is sent in one write rather
 * than a loop of them — a loop of writers is how the last one wins.
 */
export async function changeNotes(
  root: string,
  input: NotesChange,
): Promise<Note[]> {
  // Checked here too, not only at the route: this is the one door to the file.
  const change = parseChange(input);

  return withStore(NAME, async () => {
    const store = await readNamespaced<Note>(NAME, isStoredNote);
    const forRoot: Record<string, Note> = {};
    for (const [id, note] of Object.entries(store[root] ?? {})) {
      forRoot[id] = normalize(note);
    }

    switch (change.op) {
      case "save": {
        const prior = forRoot[change.note.id];
        // Only a draft's words can change: a sent note is what the agent read.
        if (prior && prior.sentAt !== null) throw new Error("Invalid edit: already sent");
        forRoot[change.note.id] = normalize({
          ...change.note,
          // An edit changes what you said, not when you first said it.
          createdAt: prior?.createdAt ?? change.note.createdAt,
          sentAt: null,
          done: false,
        });
        break;
      }
      case "remove":
        delete forRoot[change.id];
        break;
      case "send":
        for (const id of change.ids) {
          const note = forRoot[id];
          if (note && note.sentAt === null) forRoot[id] = { ...note, sentAt: change.at };
        }
        break;
      case "unsend":
        for (const id of change.ids) {
          const note = forRoot[id];
          if (note && note.sentAt !== null) {
            forRoot[id] = { ...note, sentAt: null, done: false, doneAt: null };
          }
        }
        break;
      case "tick": {
        const note = forRoot[change.id];
        if (note && note.sentAt !== null) {
          forRoot[change.id] = {
            ...note,
            done: change.done,
            // Only stamp on the transition, so re-ticking doesn't reset it.
            doneAt: change.done ? (note.done ? note.doneAt : Date.now()) : null,
          };
        }
        break;
      }
      case "clearDrafts":
        for (const [id, note] of Object.entries(forRoot)) {
          if (note.sentAt === null) delete forRoot[id];
        }
        break;
      case "clearDone":
        for (const [id, note] of Object.entries(forRoot)) {
          if (note.done) delete forRoot[id];
        }
        break;
    }

    if (Object.keys(forRoot).length === 0) delete store[root];
    else store[root] = forRoot;

    await writeNamespaced(NAME, store);
    return sorted(forRoot);
  });
}
