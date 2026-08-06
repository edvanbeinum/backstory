"use client";

import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { ChevronDownIcon, ChevronRightIcon, CommentIcon } from "./icons";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * The left column: the comment you're working on, held still while you browse
 * commits on the right.
 *
 * Its own ‹ › stepper is the point — comments and commits are separate axes,
 * so moving through comments must not depend on which list the rail happens
 * to be showing.
 */
export function CommentPane({
  threads,
  thread,
  index,
  onStep,
  repo,
  pr,
  commit,
  onPin,
  pinCandidates,
  onDraftChange,
}: {
  threads: ReviewThread[];
  thread: ReviewThread | null;
  /** Position of `thread` within `threads`, for the "2 of 6" readout */
  index: number;
  onStep: (delta: number) => void;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  /** The commit a reply would link to — the change column's selection */
  commit: CommitSummary | null;
  onPin?: (threadId: string, sha: string | null) => void;
  pinCandidates?: CommitSummary[];
  onDraftChange?: (threadId: string, text: string | null) => void;
}) {
  if (threads.length === 0) {
    return (
      <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-8 text-center text-[12px] text-[var(--fg-muted)]">
        No review comments on this pull request.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <CommentIcon size={13} className="text-[var(--fg-muted)]" />
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Comment {index + 1} of {threads.length}
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
        <ReviewThreadCard
          key={thread.id}
          thread={thread}
          repo={repo}
          pr={pr}
          commit={commit}
          showContext
          defaultCollapsed={false}
          onPin={onPin}
          pinCandidates={pinCandidates}
          onDraftChange={onDraftChange}
        />
      ) : (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-6 text-center text-[12px] text-[var(--fg-muted)]">
          <ChevronDownIcon size={13} className="text-[var(--fg-subtle)] mr-1" />
          Pick a comment from the rail.
        </p>
      )}
    </div>
  );
}
