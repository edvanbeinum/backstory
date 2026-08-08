"use client";

import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { CompletionCard } from "./CompletionCard";
import { ChevronRightIcon } from "./icons";
import { ResponsePanel } from "./ResponsePanel";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * The middle column: the comment you're working on, and what you're doing
 * about it. Held still while you browse changes on the right — comments and
 * commits are separate axes, so the ‹ › stepper here belongs to comments
 * alone.
 *
 * The tick leads, above the comment rather than below it, because it's the
 * thing you came here to do.
 */
export function CommentPane({
  threads,
  thread,
  index,
  onStep,
  repo,
  pr,
  commit,
  branch,
  commitCandidates,
  onToggleDone,
  onLinkCommit,
  onDraftChange,
  onBackToInbox,
}: {
  threads: ReviewThread[];
  thread: ReviewThread | null;
  /** Position of `thread` within `threads`, for the "3 of 7" readout */
  index: number;
  onStep: (delta: number) => void;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  /** The change on screen in the diff column — what a link would point at */
  commit: CommitSummary | null;
  branch: string | null;
  commitCandidates?: CommitSummary[];
  onToggleDone: (threadId: string, done: boolean) => void;
  onLinkCommit: (threadId: string, sha: string | null) => void;
  onDraftChange?: (threadId: string, text: string | null) => void;
  onBackToInbox?: () => void;
}) {
  if (threads.length === 0) {
    return (
      <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-8 text-center text-[12px] text-[var(--fg-muted)]">
        No review comments on this pull request.
      </p>
    );
  }

  const allDone = threads.every((t) => t.response.done);
  const where = thread?.path
    ? `${thread.path.split("/").pop()}${thread.line != null ? `:${thread.line}` : ""}`
    : thread
      ? "Review summary"
      : null;

  return (
    <div className="space-y-2">
      {/* The payoff sits above everything, so finishing the last comment is
          impossible to miss — it's the moment the whole app is for. */}
      {allDone && (
        <CompletionCard
          threads={threads}
          branch={branch}
          repo={repo}
          pr={pr}
          onBack={onBackToInbox}
        />
      )}

      <div className="flex items-center gap-2 px-0.5">
        <h2 className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Comment {index + 1} of {threads.length}
          {where && <span className="normal-case"> · {where}</span>}
        </h2>
        <button
          type="button"
          aria-label="Previous comment"
          disabled={index <= 0}
          onClick={() => onStep(-1)}
          className="rotate-180 rounded p-0.5 text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
        >
          <ChevronRightIcon size={14} />
        </button>
        <button
          type="button"
          aria-label="Next comment"
          disabled={index >= threads.length - 1}
          onClick={() => onStep(1)}
          className="rounded p-0.5 text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>

      {thread ? (
        <>
          <ResponsePanel
            key={`${thread.id}-response`}
            thread={thread}
            repo={repo}
            pr={pr}
            commit={commit}
            commitCandidates={commitCandidates}
            onToggleDone={onToggleDone}
            onLinkCommit={onLinkCommit}
            onDraftChange={onDraftChange}
          />
          <ReviewThreadCard
            key={thread.id}
            thread={thread}
            repo={repo}
            pr={pr}
            commit={commit}
            showContext
            defaultCollapsed={false}
            hideComposer
          />
        </>
      ) : (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-6 text-center text-[12px] text-[var(--fg-muted)]">
          Pick a comment from the spine.
        </p>
      )}
    </div>
  );
}
