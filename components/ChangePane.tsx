"use client";

import { useMemo } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type {
  CommitSummary,
  DiffResponse,
  ReviewThread,
  SessionResponse,
} from "@/lib/types";
import { CommitHeader } from "./CommitHeader";
import { DiffView } from "./DiffView";
import {
  CommentIcon,
  FileDiffIcon,
  GitCommitIcon,
  PencilIcon,
} from "./icons";

export interface ChangeOption {
  rev: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

/**
 * The changes worth offering for the comment on screen, best first.
 *
 * Uncommitted leads when the working tree touches the comment's file: that's
 * where you are when you check a comment mid-fix, and it's the one thing a
 * commit-only view can never show.
 */
export function changesFor(
  thread: ReviewThread | null,
  session: SessionResponse,
): ChangeOption[] {
  const options: ChangeOption[] = [];

  // Uncommitted work is always offered when there is any; what changes is
  // whether it leads. It only leads when it touches this comment's file —
  // that's the mid-fix case, and the reason it's worth defaulting to.
  const touchesThisComment = Boolean(
    thread?.path && session.working.changedPaths.includes(thread.path),
  );
  const uncommitted: ChangeOption | null = session.working.hasChanges
    ? {
        rev: WORKING_REV,
        label: "Uncommitted",
        hint: touchesThisComment
          ? "your working-tree changes to this file, not yet committed"
          : "your working-tree changes, not yet committed",
        icon: <PencilIcon size={12} />,
      }
    : null;

  if (uncommitted && touchesThisComment) options.push(uncommitted);

  const linked = thread
    ? ((thread.pinnedShaMissing ? null : thread.pinnedSha) ??
      thread.addressedBySha ??
      null)
    : null;
  if (linked) {
    const commit =
      session.commits.find((c) => c.sha === linked) ??
      session.history.find((c) => c.sha === linked);
    options.push({
      rev: linked,
      label: linked.slice(0, 7),
      hint: thread?.pinnedSha
        ? `pinned: ${commit?.subject ?? "commit"}`
        : `last commit to touch this file: ${commit?.subject ?? "commit"}`,
      icon: <GitCommitIcon size={12} />,
    });
  }

  // Uncommitted that doesn't touch this file still belongs on the list, just
  // not at the front.
  if (uncommitted && !touchesThisComment) options.push(uncommitted);

  if (session.branchDiff) {
    options.push({
      rev: BRANCH_REV,
      label: "All changes",
      hint: `everything ${session.branchDiff.label}`,
      icon: <FileDiffIcon size={12} />,
    });
  }

  return options;
}

/** Which change should open when a comment is selected. */
export function bestChangeFor(
  thread: ReviewThread | null,
  session: SessionResponse,
): string | null {
  return changesFor(thread, session)[0]?.rev ?? null;
}

/**
 * The right column: the change you're inspecting, independent of which
 * comment is on the left. Selecting a commit in the rail lands here and
 * leaves the comment alone.
 */
export function ChangePane({
  session,
  rev,
  onRevChange,
  commit,
  diff,
  loading,
  error,
  threads,
  thread,
  focusedThreadId,
  onPin,
  pinCandidates,
  onDraftChange,
  pushed,
}: {
  session: SessionResponse;
  rev: string;
  onRevChange: (rev: string) => void;
  commit: CommitSummary | null;
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  /** The comment on the left, so its thread can be highlighted here */
  thread: ReviewThread | null;
  focusedThreadId: string | null;
  onPin?: (threadId: string, sha: string | null) => void;
  pinCandidates?: CommitSummary[];
  onDraftChange?: (threadId: string, text: string | null) => void;
  pushed: boolean;
}) {
  const options = useMemo(
    () => changesFor(thread, session),
    [thread, session],
  );

  // How many comments this change answers — the reverse lookup that was
  // missing: given a commit, which review comments land in it?
  const landing = useMemo(
    () =>
      threads.filter((t) => {
        const linked =
          (t.pinnedShaMissing ? null : t.pinnedSha) ?? t.addressedBySha ?? null;
        return linked !== null && linked === rev;
      }),
    [threads, rev],
  );

  return (
    <div className="space-y-3">
      {options.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[var(--fg-muted)]">Showing</span>
          {options.map((option) => (
            <button
              key={option.rev}
              type="button"
              title={option.hint}
              onClick={() => onRevChange(option.rev)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                rev === option.rev
                  ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
              }`}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
          {/* A commit picked from the rail that isn't one of the offered
              options still needs to read as the current selection. */}
          {!options.some((o) => o.rev === rev) && commit && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-subtle)] px-2.5 py-[3px] text-[11px] font-medium text-[var(--accent)]">
              <GitCommitIcon size={12} />
              {commit.shortSha}
            </span>
          )}
        </div>
      )}

      {landing.length > 0 && (
        <p className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] text-[var(--fg-muted)]">
          <CommentIcon size={12} className="text-[var(--attention)]" />
          {landing.length} {landing.length === 1 ? "comment" : "comments"} land
          {landing.length === 1 ? "s" : ""} in this change
          {thread && landing.some((t) => t.id === thread.id) && (
            <span className="text-[var(--accent)]">
              · including the one on the left
            </span>
          )}
        </p>
      )}

      <CommitHeader
        commit={commit}
        diff={diff}
        repo={session.repo}
        pr={session.github.pr}
        pushed={pushed}
      />

      <DiffView
        diff={diff}
        loading={loading}
        error={error}
        threads={threads}
        reviews={session.github.reviews}
        repo={session.repo}
        pr={session.github.pr}
        commit={commit}
        focusedThreadId={focusedThreadId}
        onPin={onPin}
        pinCandidates={pinCandidates}
        onDraftChange={onDraftChange}
      />
    </div>
  );
}
