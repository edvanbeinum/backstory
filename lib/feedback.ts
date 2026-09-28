import { filePaths } from "./anchor";
import type { DiffFile, Note } from "./types";

/**
 * Notes on uncommitted work, and the text they leave as.
 *
 * Pure, so the window can build the copy synchronously on click and the tests
 * don't need a store.
 */

export interface AnchoredNotes {
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

function heading(note: Note, at: number | null): string {
  if (note.side === "old") {
    return `${note.path} — removed line ${at ?? note.line}`;
  }
  if (at !== null) return `${note.path}:${at}`;
  // Said plainly rather than guessed at: the quote is what lets the reader
  // find it, and the number is only where it used to be.
  return `${note.path} (was line ${note.line}; it has changed since)`;
}

/**
 * The notes as one markdown message for an agent (or a person).
 *
 * Each line note carries its quoted line, not just a number: by the time it's
 * read the file may have moved again, and the text is what survives. Notes
 * are grouped in diff order so the message reads top to bottom like the
 * change does; general notes go last, as the summing-up.
 */
export function formatFeedback(notes: Note[], files: DiffFile[]): string {
  const general = notes.filter((n) => !n.path);
  const onLines = notes.filter((n) => n.path);

  const order = new Map(files.map((f, i) => [f.path, i]));
  const placed = onLines
    .map((note) => {
      const file = fileForNote(files, note);
      return {
        note,
        file,
        at: file ? locateNote(file, note) : null,
      };
    })
    .sort(
      (a, b) =>
        (a.file ? (order.get(a.file.path) ?? 0) : Infinity) -
          (b.file ? (order.get(b.file.path) ?? 0) : Infinity) ||
        (a.note.path ?? "").localeCompare(b.note.path ?? "") ||
        (a.at ?? a.note.line ?? 0) - (b.at ?? b.note.line ?? 0) ||
        a.note.createdAt - b.note.createdAt,
    );

  const count = notes.length;
  const parts = [
    `Feedback on the uncommitted changes (${count} ${count === 1 ? "note" : "notes"}):`,
  ];

  for (const { note, file, at } of placed) {
    const lines = [`## ${heading(note, at)}`];
    if (note.quote !== null) {
      const f = fence(note.quote);
      lines.push(`${f}${file?.lang ?? ""}`, note.quote, f);
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
