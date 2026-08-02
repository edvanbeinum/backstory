import type { DiffFile, ReviewThread } from "./types";

export interface AnchoredThreads {
  /** New-side line number → threads that belong on it */
  byNewLine: Map<number, ReviewThread[]>;
  /** Old-side line number → threads that belong on it */
  byOldLine: Map<number, ReviewThread[]>;
  /** Threads for this file that don't land on any line in this diff */
  unanchored: ReviewThread[];
}

/**
 * Work out which review threads land on which line of a file's diff.
 *
 * This is the whole point of the app: a comment on SearchBox.tsx:34 should
 * render *on line 34 of the commit you're looking at*, so "did this change
 * actually answer the review?" becomes a glance instead of a memory test.
 *
 * A thread only anchors if its line is genuinely present in one of the hunks —
 * hunks skip most of a file, so a line number inside the file but outside the
 * diff must fall through to `unanchored` rather than be dropped or guessed at.
 * Nothing is ever silently discarded; unanchored threads are still rendered,
 * just elsewhere.
 */
export function anchorThreads(
  file: DiffFile,
  threads: ReviewThread[],
): AnchoredThreads {
  const byNewLine = new Map<number, ReviewThread[]>();
  const byOldLine = new Map<number, ReviewThread[]>();
  const unanchored: ReviewThread[] = [];

  const newLines = new Set<number>();
  const oldLines = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newNo != null) newLines.add(line.newNo);
      if (line.oldNo != null) oldLines.add(line.oldNo);
    }
  }

  const add = (map: Map<number, ReviewThread[]>, key: number, t: ReviewThread) =>
    map.set(key, [...(map.get(key) ?? []), t]);

  for (const thread of threads) {
    // `line` is null once GitHub marks a thread outdated; originalLine still
    // points at where it was written, which is usually close enough to be
    // useful and is better than dropping it to the bottom of the page.
    const line = thread.line ?? thread.originalLine;
    if (line == null) {
      unanchored.push(thread);
      continue;
    }

    if (thread.side === "LEFT") {
      if (oldLines.has(line)) add(byOldLine, line, thread);
      else unanchored.push(thread);
      continue;
    }

    if (newLines.has(line)) add(byNewLine, line, thread);
    else unanchored.push(thread);
  }

  return { byNewLine, byOldLine, unanchored };
}

/** Every path a file is known by, for matching threads to files. */
export function filePaths(file: DiffFile): string[] {
  return [file.newPath, file.oldPath].filter((p): p is string => Boolean(p));
}
