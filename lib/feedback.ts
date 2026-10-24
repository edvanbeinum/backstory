import { filePaths } from "./anchor";
import { BRANCH_REV, WORKING_REV } from "./constants";
import { langForPath } from "./lang";
import type { DiffFile, Note } from "./types";

/**
 * Notes on uncommitted work, and the text they leave as.
 *
 * Pure, so the window can build the copy synchronously on click and the tests
 * don't need a store.
 */

interface AnchoredNotes {
  /** New-side line number → notes on it, where the note's line is now */
  byNewLine: Map<number, Note[]>;
  byOldLine: Map<number, Note[]>;
  /** This file's notes whose line can't be found in the diff as shown */
  unanchored: Note[];
}

/**
 * Where a note's line is in the diff now, or null if it can't be said.
 *
 * The working tree moves under a note in a way a commit never does: add a line
 * above it and its number is wrong. So a note is found by its text first —
 * still on its line, fine; moved, and the text appears exactly once on that
 * side of the diff, that's where it went. Anything else — gone, edited, or
 * one of several identical `}` lines — is null. Picking the nearest of three
 * candidates would read as confident and be wrong a third of the time.
 */
export function locateNote(file: DiffFile, note: Note): number | null {
  if (note.line == null) return null;

  const onSide: Array<{ no: number; content: string }> = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const no = note.side === "old" ? line.oldNo : line.newNo;
      // An old-side note belongs on a removed line; the same number on a
      // context row is a different line of a different file revision.
      if (no == null || (note.side === "old" && line.type !== "del")) continue;
      onSide.push({ no, content: line.content });
    }
  }

  const here = onSide.find((l) => l.no === note.line);
  if (here && (note.quote === null || here.content === note.quote)) {
    return here.no;
  }
  if (note.quote === null) return null;

  const matches = onSide.filter((l) => l.content === note.quote);
  return matches.length === 1 ? matches[0].no : null;
}

/** Sort one file's notes onto its lines. Nothing is dropped. */
export function anchorNotes(file: DiffFile, notes: Note[]): AnchoredNotes {
  const byNewLine = new Map<number, Note[]>();
  const byOldLine = new Map<number, Note[]>();
  const unanchored: Note[] = [];

  for (const note of notes) {
    const at = locateNote(file, note);
    if (at === null) {
      unanchored.push(note);
      continue;
    }
    const map = note.side === "old" ? byOldLine : byNewLine;
    map.set(at, [...(map.get(at) ?? []), note]);
  }
  return { byNewLine, byOldLine, unanchored };
}

/** The file in the diff a note belongs to, by either of its names. */
export function fileForNote(
  files: DiffFile[],
  note: Note,
): DiffFile | undefined {
  if (!note.path) return undefined;
  return files.find((f) => filePaths(f).includes(note.path!));
}

/** A code fence longer than any backtick run inside it, so it can't close early. */
function fence(text: string): string {
  const longest = Math.max(
    2,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  return "`".repeat(longest + 1);
}

/** A commit notes may have been left on, as the session knows it. */
export interface NoteCommit {
  sha: string;
  subject: string;
  /** Null when Backstory can't tell — then the message doesn't say */
  pushed: boolean | null;
}

/** What the formatter knows about the changes the notes were left on. */
interface FeedbackContext {
  /**
   * Diffs by rev, for finding where a note's line is now. A commit's needn't
   * be here — its lines can't move — but uncommitted work and the branch
   * diff should be, or their notes can only give the line they were left on.
   */
  diffs: Map<string, DiffFile[]>;
  /** The branch's commits, oldest first — the order the message follows */
  commits: NoteCommit[];
  /** The branch opened by ref, whose tip is the branch diff's end, not HEAD */
  ref?: string | null;
}

/**
 * Where a note's change sits, as a fact rather than advice: which commit, and
 * whether it's been pushed. How to fix it — a fixup, a new commit — depends on
 * how you and the agent are working, which Backstory can't see.
 */
function whereQualifier(
  note: Note,
  commits: NoteCommit[],
  mixed: boolean,
  ref: string | null,
): string | null {
  if (note.rev === WORKING_REV) return mixed ? "uncommitted" : null;
  if (note.rev === BRANCH_REV)
    return ref ? `committed, at the tip of ${ref}` : "committed, at HEAD";
  const commit = commits.find((c) => c.sha === note.rev);
  const short = note.rev.slice(0, 7);
  if (!commit) return `in ${short}, which is no longer on this branch`;
  const subject = `in ${short} "${commit.subject}"`;
  if (commit.pushed === null) return subject;
  return `${subject}, ${commit.pushed ? "already pushed" : "not yet pushed"}`;
}

function heading(
  note: Note,
  files: DiffFile[] | null,
  at: number | null,
  where: string | null,
): string {
  const qualifiers: string[] = [];
  let location: string;

  if (files === null) {
    // Not loaded, so the line it was left on is all there is — exact for a
    // commit, whose diff can't have moved.
    location =
      note.side === "old"
        ? `${note.path} — removed line ${note.line}`
        : `${note.path}:${note.line}`;
  } else if (!fileForNote(files, note)) {
    location = note.path!;
    qualifiers.push(
      `was line ${note.line}`,
      note.rev === WORKING_REV
        ? "the file has no uncommitted changes now"
        : "the file is no longer in this change",
    );
  } else if (at === null) {
    // Said plainly rather than guessed at: the quote is what lets the reader
    // find it, and the number is only where it used to be.
    location = note.path!;
    qualifiers.push(`was line ${note.line}`, "it has changed since");
  } else {
    location =
      note.side === "old"
        ? `${note.path} — removed line ${at}`
        : `${note.path}:${at}`;
  }

  if (where) qualifiers.push(where);
  return qualifiers.length > 0
    ? `${location} (${qualifiers.join("; ")})`
    : location;
}

/** Commits oldest first, then the branch as a whole, then uncommitted work. */
function revRank(rev: string, commits: NoteCommit[]): number {
  if (rev === WORKING_REV) return commits.length + 2;
  if (rev === BRANCH_REV) return commits.length + 1;
  const index = commits.findIndex((c) => c.sha === rev);
  return index === -1 ? commits.length : index;
}

/**
 * The notes as one markdown message for an agent (or a person).
 *
 * Each line note carries its quoted line, not just a number: by the time it's
 * read the file may have moved again, and the text is what survives. Notes
 * read in the order the work happened — the branch's commits oldest first,
 * then uncommitted work — and in diff order within each; general notes go
 * last, as the summing-up.
 */
export function formatFeedback(
  notes: Note[],
  context: FeedbackContext,
): string {
  const { diffs, commits } = context;
  const general = notes.filter((n) => !n.path);
  const onLines = notes.filter((n) => n.path);
  const mixed = notes.some((n) => n.rev !== WORKING_REV);

  const placed = onLines
    .map((note) => {
      const files = diffs.get(note.rev) ?? null;
      const file = files ? fileForNote(files, note) : undefined;
      return {
        note,
        files,
        file,
        fileIndex: file && files ? files.indexOf(file) : Infinity,
        at: file ? locateNote(file, note) : null,
      };
    })
    .sort(
      (a, b) =>
        revRank(a.note.rev, commits) - revRank(b.note.rev, commits) ||
        // Infinity - Infinity is NaN, which is falsy: falls through to path.
        a.fileIndex - b.fileIndex ||
        (a.note.path ?? "").localeCompare(b.note.path ?? "") ||
        (a.at ?? a.note.line ?? 0) - (b.at ?? b.note.line ?? 0) ||
        a.note.createdAt - b.note.createdAt,
    );

  const count = notes.length;
  const noun = `${count} ${count === 1 ? "note" : "notes"}`;
  const parts = [
    mixed
      ? `Review feedback (${noun}):`
      : `Feedback on the uncommitted changes (${noun}):`,
  ];

  for (const { note, files, file, at } of placed) {
    const where = whereQualifier(note, commits, mixed, context.ref ?? null);
    const lines = [`## ${heading(note, files, at, where)}`];
    if (note.quote !== null) {
      const f = fence(note.quote);
      lines.push(
        `${f}${file?.lang ?? langForPath(note.path) ?? ""}`,
        note.quote,
        f,
      );
    }
    lines.push(note.body.trim());
    parts.push(lines.join("\n"));
  }

  if (general.length > 0) {
    parts.push(
      ["## General", ...general.map((n) => n.body.trim())].join("\n\n"),
    );
  }

  return parts.join("\n\n") + "\n";
}

/** A new draft note; everything about rounds and ticks starts empty. */
export function draftNote(
  fields: Pick<Note, "rev" | "path" | "side" | "line" | "quote" | "body">,
): Note {
  return {
    ...fields,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    sentAt: null,
    done: false,
    doneAt: null,
  };
}
