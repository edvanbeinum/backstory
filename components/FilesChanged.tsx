"use client";

import { useEffect } from "react";

import type { StepMarks } from "@/lib/flows/rows";
import type {
  CommitSummary,
  DiffResponse,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { DiffView } from "./DiffView";
import { jumpToFile } from "./SystemMap";
import type { NotesApi } from "./useNotes";

/** A file, or a line in it, for Files changed to bring up once it renders. */
export interface FilesJump {
  path: string;
  side?: "old" | "new";
  line?: number;
  /** When it was asked for, so asking twice jumps twice */
  at: number;
}

/** Ask a file to show a line that's outside the hunks on screen. */
function revealLine(path: string, side: "old" | "new", line: number) {
  window.dispatchEvent(
    new CustomEvent("backstory:reveal", { detail: { path, side, line } }),
  );
}

const sectionFor = (path: string) =>
  document.getElementById(`file-${encodeURIComponent(path)}`);

/** The line, once its file has rendered it. */
const rowFor = (path: string, side: "old" | "new", line: number) =>
  sectionFor(path)?.querySelector<HTMLElement>(
    `tr[data-${side}-line="${line}"]`,
  ) ?? null;

/** Files changed: the whole diff. */
export function FilesChanged({
  diff,
  loading,
  error,
  threads,
  repo,
  commit,
  focusedThreadId,
  notes,
  noteRev,
  fileComponents,
  marks,
  jump,
  onJumped,
}: {
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  repo: RepoInfo;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  notes: NotesApi | null;
  noteRev: string | null;
  fileComponents: Record<string, string> | null;
  /** Every flow's steps, by file */
  marks: Map<string, StepMarks> | null;
  jump: FilesJump | null;
  onJumped: () => void;
  /** A filter to open with, from the story's "read these yourself" */
  filterAsk?: { filter: "yourself"; at: number } | null;
}) {
  // The tab mounts, then the diff renders: wait for the file, then the line.
  // A line outside the hunks asks its file to show the whole file first.
  useEffect(() => {
    if (!jump) return;
    let tries = 0;
    let revealed = false;
    const poll = setInterval(() => {
      const { path, side, line } = jump;
      let done = false;
      if (side && line !== undefined) {
        const row = rowFor(path, side, line);
        if (row) {
          row.scrollIntoView({ block: "center" });
          row.classList.remove("flash");
          void row.offsetWidth;
          row.classList.add("flash");
          done = true;
        } else if (sectionFor(path) && !revealed) {
          revealLine(path, side, line);
          revealed = true;
        }
      } else {
        done = jumpToFile(path);
      }
      if (!done && ++tries > 50) done = jumpToFile(path) || true;
      if (done) {
        clearInterval(poll);
        onJumped();
      }
    }, 100);
    return () => clearInterval(poll);
  }, [jump, onJumped]);

  return (
    <DiffView
      diff={diff}
      loading={loading}
      error={error}
      threads={threads}
      repo={repo}
      commit={commit}
      focusedThreadId={focusedThreadId}
      notes={notes}
      noteRev={noteRev}
      marks={marks}
      fileComponents={fileComponents}
    />
  );
}
