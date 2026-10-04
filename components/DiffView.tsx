"use client";

import { useMemo } from "react";

import { fileForNote } from "@/lib/feedback";
import type {
  CommitSummary,
  DiffFile as DiffFileType,
  DiffResponse,
  Note,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { DiffFile, type FileMarks } from "./DiffFile";
import { FileNav } from "./FileNav";
import { AlertIcon, CommentIcon } from "./icons";
import { Spinner } from "./ui";
import type { NotesApi } from "./useNotes";

/**
 * Group threads by the file they belong to, so each DiffFile only has to
 * consider its own — and only to mark the line the comment you're reading
 * points at. Nothing here renders a comment: the spine lists them all and the
 * response panel answers them, so repeating them among the code was three
 * copies of one list.
 */
function partitionThreads(diff: DiffResponse | null, threads: ReviewThread[]) {
  const paths = new Set(
    (diff?.files ?? []).flatMap((file) =>
      [file.newPath, file.oldPath].filter((p): p is string => Boolean(p)),
    ),
  );

  const perFile = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.path && paths.has(thread.path)) {
      perFile.set(thread.path, [...(perFile.get(thread.path) ?? []), thread]);
    }
  }
  return { perFile };
}

/**
 * A renamed file's removed steps sit under its old path and the rest under
 * its new one; the file needs both.
 */
function marksFor(
  marks: Map<string, FileMarks> | null,
  file: DiffFileType,
): FileMarks | null {
  if (!marks) return null;
  const a = file.newPath ? marks.get(file.newPath) : undefined;
  const b =
    file.oldPath && file.oldPath !== file.newPath
      ? marks.get(file.oldPath)
      : undefined;
  if (!a || !b) return a ?? b ?? null;
  return {
    old: new Map([...a.old, ...b.old]),
    new: new Map([...a.new, ...b.new]),
  };
}

/** One shared empty list, so files without notes keep a stable prop. */
const NO_NOTES: Note[] = [];

export function DiffView({
  diff,
  loading,
  error,
  threads,
  repo,
  pr,
  commit,
  focusedThreadId,
  notes = null,
  noteRev = null,
  marks = null,
  fileComponents = null,
  hoveredComponent = null,
}: {
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  /** Set when this diff takes notes */
  notes?: NotesApi | null;
  /** The change on screen, as notes record it: a full sha, or a pseudo-rev */
  noteRev?: string | null;
  /** The selected flow's steps, by file */
  marks?: Map<string, FileMarks> | null;
  fileComponents?: Record<string, string> | null;
  hoveredComponent?: string | null;
}) {
  const { perFile } = useMemo(
    () => partitionThreads(diff, threads),
    [diff, threads],
  );

  const noteList = notes?.notes;
  const notesPerFile = useMemo(() => {
    const map = new Map<DiffFileType, Note[]>();
    if (!diff || !noteList) return map;
    // Only this change's notes: the same line number in another commit is a
    // different line.
    for (const note of noteList) {
      if (note.rev !== noteRev) continue;
      const file = fileForNote(diff.files, note);
      if (file) map.set(file, [...(map.get(file) ?? []), note]);
    }
    return map;
  }, [diff, noteList, noteRev]);

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--canvas)] p-4 text-[13px]">
        <AlertIcon className="mt-0.5 text-[var(--danger)]" />
        <span>{error}</span>
      </div>
    );
  }

  if (loading && !diff) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[var(--fg-muted)]">
        <Spinner /> Loading diff…
      </div>
    );
  }

  if (!diff) return null;

  return (
    <div className="space-y-3">
      {diff.highlightSkipped && (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          Large diff — syntax highlighting skipped to keep things responsive.
        </p>
      )}

      <FileNav files={diff.files} threads={threads} />

      {diff.files.length === 0 ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-8 text-center text-[13px] text-[var(--fg-muted)]">
          This commit doesn&apos;t change any files.
        </p>
      ) : (
        diff.files.map((file) => (
          <DiffFile
            key={`${file.oldPath}-${file.newPath}`}
            file={file}
            threads={[
              ...(file.newPath ? (perFile.get(file.newPath) ?? []) : []),
              ...(file.oldPath && file.oldPath !== file.newPath
                ? (perFile.get(file.oldPath) ?? [])
                : []),
            ]}
            repo={repo}
            pr={pr}
            commit={commit}
            focusedThreadId={focusedThreadId}
            notes={notes}
            noteRev={noteRev}
            fileNotes={notesPerFile.get(file) ?? NO_NOTES}
            marks={marksFor(marks, file)}
            component={fileComponents?.[file.path] ?? null}
            linked={
              hoveredComponent !== null &&
              fileComponents?.[file.path] === hoveredComponent
            }
          />
        ))
      )}
    </div>
  );
}
