import { KEY, readNamespaced, withStore, writeNamespaced } from "./store";
import type { Note } from "./types";

/**
 * Notes on uncommitted work, per checkout.
 *
 * Keyed by the worktree's root rather than a PR: uncommitted changes belong
 * to one directory on disk, often before any PR exists, and two worktrees of
 * the same repo are two different pieces of work.
 *
 * Shape: { "/abs/path/to/worktree": { "<noteId>": Note } }
 */

const NAME = "notes";

const MAX_BODY = 20_000;
const MAX_QUOTE = 2_000;
const MAX_PATH = 1_000;

/** The file is meant to be hand-editable, so nothing in it is trusted. */
function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    (n.path === null || (typeof n.path === "string" && n.path.length <= MAX_PATH)) &&
    (n.side === "old" || n.side === "new") &&
    (n.line === null || (Number.isInteger(n.line) && (n.line as number) > 0)) &&
    (n.quote === null || (typeof n.quote === "string" && n.quote.length <= MAX_QUOTE)) &&
    typeof n.body === "string" &&
    n.body.length <= MAX_BODY &&
    typeof n.createdAt === "number"
  );
}

/** Oldest first, which is the order you wrote them in. */
function sorted(notes: Record<string, Note>): Note[] {
  return Object.values(notes).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getNotes(root: string): Promise<Note[]> {
  const store = await readNamespaced<Note>(NAME, isNote);
  return sorted(store[root] ?? {});
}

export type NotesChange =
  | { save: Note }
  | { remove: string }
  | { clear: true };

/**
 * The only mutator. Every change is a read-modify-write of the whole file, so
 * it runs under the store's lock — a note saved while another is removed
 * mustn't lose either.
 */
export async function changeNotes(
  root: string,
  change: NotesChange,
): Promise<Note[]> {
  if ("save" in change) {
    const note = change.save;
    if (!KEY.test(note.id)) throw new Error("Invalid note id");
    if (!isNote(note)) throw new Error("Invalid note");
    if (!note.body.trim()) throw new Error("Invalid note: empty");
  } else if ("remove" in change && !KEY.test(change.remove)) {
    throw new Error("Invalid note id");
  }

  return withStore(NAME, async () => {
    const store = await readNamespaced<Note>(NAME, isNote);
    const forRoot = { ...(store[root] ?? {}) };

    if ("save" in change) {
      const prior = forRoot[change.save.id];
      // An edit changes what you said, not when you first said it.
      forRoot[change.save.id] = {
        ...change.save,
        createdAt: prior?.createdAt ?? change.save.createdAt,
      };
    } else if ("remove" in change) {
      delete forRoot[change.remove];
    } else {
      for (const id of Object.keys(forRoot)) delete forRoot[id];
    }

    if (Object.keys(forRoot).length === 0) delete store[root];
    else store[root] = forRoot;

    await writeNamespaced(NAME, store);
    return sorted(forRoot);
  });
}
