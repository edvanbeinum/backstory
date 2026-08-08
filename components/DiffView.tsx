"use client";

import { useMemo } from "react";

import type {
  CommitSummary,
  DiffResponse,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { DiffFile } from "./DiffFile";
import { FileNav } from "./FileNav";
import { AlertIcon, CommentIcon } from "./icons";
import { Spinner } from "./ui";

/**
 * Group threads by the file they belong to, so each DiffFile only has to
 * consider its own. Threads on files this commit doesn't touch fall through to
 * "elsewhere" and are still shown — hiding them would quietly lose review
 * feedback, which is the one thing this app must never do.
 */
function partitionThreads(diff: DiffResponse | null, threads: ReviewThread[]) {
  const paths = new Set(
    (diff?.files ?? []).flatMap((file) =>
      [file.newPath, file.oldPath].filter((p): p is string => Boolean(p)),
    ),
  );

  const perFile = new Map<string, ReviewThread[]>();
  const elsewhere: ReviewThread[] = [];

  for (const thread of threads) {
    if (thread.path && paths.has(thread.path)) {
      perFile.set(thread.path, [...(perFile.get(thread.path) ?? []), thread]);
    } else if (thread.path) {
      elsewhere.push(thread);
    }
    // Review summaries have no file, and the comment column already shows
    // them — repeating them under the diff would just be noise.
  }

  return { perFile, elsewhere };
}

export function DiffView({
  diff,
  loading,
  error,
  threads,
  repo,
  pr,
  commit,
  focusedThreadId,
  onSelectThread,
}: {
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  /** Hand a comment to the response panel, which owns answering it. */
  onSelectThread?: (threadId: string) => void;
}) {
  const { perFile, elsewhere } = useMemo(
    () => partitionThreads(diff, threads),
    [diff, threads],
  );

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
            onSelectThread={onSelectThread}
          />
        ))
      )}

      {/* This used to re-render every off-file thread as a card, composer and
          all. The spine already lists every comment, always visible — so the
          section was the same list a third time, and a second live composer
          per thread on top of it. One line is enough. */}
      {elsewhere.length > 0 && (
        <p className="flex items-center gap-1.5 px-1 pt-1 text-[12px] text-[var(--fg-muted)]">
          <CommentIcon size={12} />
          {elsewhere.length}{" "}
          {elsewhere.length === 1 ? "comment is" : "comments are"}{" "}
          on files this change doesn&apos;t touch — see the spine.
        </p>
      )}
    </div>
  );
}
