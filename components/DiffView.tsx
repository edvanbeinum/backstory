"use client";

import { useMemo } from "react";

import type {
  CommitSummary,
  DiffResponse,
  PullRequestInfo,
  RepoInfo,
  ReviewSummary,
  ReviewThread,
} from "@/lib/types";
import { DiffFile } from "./DiffFile";
import { FileNav } from "./FileNav";
import { AlertIcon, CommentIcon } from "./icons";
import { ReviewThreadCard } from "./ReviewThreadCard";
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
    } else {
      elsewhere.push(thread);
    }
  }

  return { perFile, elsewhere };
}

export function DiffView({
  diff,
  loading,
  error,
  threads,
  reviews,
  repo,
  pr,
  commit,
  focusedThreadId,
}: {
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  reviews: ReviewSummary[];
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
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
          />
        ))
      )}

      {reviews.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 pt-2 text-[13px] font-semibold">
            <CommentIcon size={14} className="text-[var(--fg-muted)]" />
            Review summaries
          </h2>
          {reviews.map((review) => (
            <div
              key={review.id}
              className="rounded-md border border-[var(--border)] bg-[var(--canvas)] p-3"
            >
              <p className="mb-1 text-[12px] text-[var(--fg-muted)]">
                <a
                  href={review.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-[var(--fg)] hover:text-[var(--accent)] hover:underline"
                >
                  {review.author}
                </a>{" "}
                {review.state.toLowerCase().replace(/_/g, " ")}
              </p>
              <p className="whitespace-pre-wrap text-[13px]">{review.body}</p>
            </div>
          ))}
        </section>
      )}

      {elsewhere.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 pt-2 text-[13px] font-semibold">
            <CommentIcon size={14} className="text-[var(--fg-muted)]" />
            Other comments on this PR
            <span className="font-normal text-[var(--fg-muted)]">
              — on files this commit doesn&apos;t touch
            </span>
          </h2>
          {elsewhere.map((thread) => (
            <ReviewThreadCard
              key={thread.id}
              thread={thread}
              repo={repo}
              pr={pr}
              commit={commit}
              showContext
              defaultCollapsed
              highlighted={focusedThreadId === thread.id}
            />
          ))}
        </section>
      )}
    </div>
  );
}
