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
  CheckIcon,
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

  if (session.branchDiff) {
    options.push({
      rev: BRANCH_REV,
      label: "All changes",
      hint: `everything ${session.branchDiff.label}`,
      icon: <FileDiffIcon size={12} />,
    });
  }

  if (session.working.hasChanges) {
    const touches = Boolean(
      thread?.path && session.working.changedPaths.includes(thread.path),
    );
    options.push({
      rev: WORKING_REV,
      label: "Uncommitted",
      hint: touches
        ? "your working-tree changes to this file, not yet committed"
        : "your working-tree changes, not yet committed",
      icon: <PencilIcon size={12} />,
    });
  }

  // A commit already linked to this comment stays offered, so returning to a
  // handled comment shows the change you said answers it.
  const linked = thread?.linkedShaMissing ? null : thread?.linkedSha;
  if (linked) {
    const commit =
      session.commits.find((c) => c.sha === linked) ??
      session.history.find((c) => c.sha === linked);
    options.push({
      rev: linked,
      label: linked.slice(0, 7),
      hint: `linked: ${commit?.subject ?? "commit"}`,
      icon: <GitCommitIcon size={12} />,
    });
  }

  return options;
}

/**
 * Where the change column opens for a comment.
 *
 * Deliberately not a guess about which commit answers it — differ doesn't
 * make that call any more. A comment you've already handled reopens on its
 * linked commit; anything else opens on the whole branch diff, which shows
 * everything without asserting anything.
 */
export function openingChangeFor(
  thread: ReviewThread | null,
  session: SessionResponse,
): string | null {
  const linked = thread?.linkedShaMissing ? null : thread?.linkedSha;
  if (linked) return linked;
  if (session.branchDiff) return BRANCH_REV;
  return session.working.hasChanges ? WORKING_REV : null;
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
  onLink,
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
  /** Record how the comment was handled: a commit, an ack, or cleared. */
  onLink?: (threadId: string, link: { sha?: string; ack?: boolean } | null) => void;
}) {
  const options = useMemo(
    () => changesFor(thread, session),
    [thread, session],
  );

  // How many comments this change answers — the reverse lookup that was
  // missing: given a commit, which review comments land in it?
  const landing = useMemo(
    () =>
      threads.filter(
        (t) => !t.linkedShaMissing && t.linkedSha === rev,
      ),
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

      {thread && (
        <LinkActions
          thread={thread}
          rev={rev}
          commit={commit}
          onLink={onLink}
        />
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

/**
 * The deliberate part: saying that this change answers the comment, or that
 * no change is needed. differ won't decide either for you — the act of
 * saying so is what makes you check, and it's the only thing that moves a
 * comment off the outstanding list.
 */
function LinkActions({
  thread,
  rev,
  commit,
  onLink,
}: {
  thread: ReviewThread;
  rev: string;
  commit: CommitSummary | null;
  onLink?: (
    threadId: string,
    link: { sha?: string; ack?: boolean } | null,
  ) => void;
}) {
  if (!onLink) return null;

  const linkedHere = !thread.linkedShaMissing && thread.linkedSha === rev;
  // Only a real commit can be linked: uncommitted work and the combined
  // branch diff have no sha to point a reply at.
  const linkable =
    commit !== null && rev !== WORKING_REV && rev !== BRANCH_REV;

  if (thread.acknowledged) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--done)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
        <CheckIcon size={13} className="text-[var(--done)]" />
        <span className="flex-1">
          Acknowledged — no code change needed.
        </span>
        <button
          type="button"
          onClick={() => onLink(thread.id, null)}
          className="text-[11px] text-[var(--accent)] hover:underline"
        >
          Undo
        </button>
      </div>
    );
  }

  if (linkedHere) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--done)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
        <CheckIcon size={13} className="text-[var(--done)]" />
        <span className="flex-1">
          This comment is answered by{" "}
          <span className="mono">{commit?.shortSha ?? rev.slice(0, 7)}</span>.
        </span>
        <button
          type="button"
          onClick={() => onLink(thread.id, null)}
          className="text-[11px] text-[var(--accent)] hover:underline"
        >
          Unlink
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2">
      <span className="flex-1 text-[12px] text-[var(--fg-muted)]">
        {thread.linkedSha && thread.linkedShaMissing
          ? "Its linked commit was rebased away — link it again."
          : "Does this change answer the comment?"}
      </span>
      <button
        type="button"
        disabled={!linkable}
        title={
          linkable
            ? `Link this comment to ${commit?.shortSha}`
            : "Select a commit — uncommitted work and the combined diff have no sha to link"
        }
        onClick={() => commit && onLink(thread.id, { sha: commit.sha })}
        className="inline-flex items-center gap-1.5 rounded-md border border-[#1f883d] bg-[#1f883d] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#1a7f37] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CheckIcon size={12} />
        This addresses it
        {linkable && (
          <span className="mono opacity-80">{commit?.shortSha}</span>
        )}
      </button>
      <button
        type="button"
        title="No code change needed — this one just wants a reply"
        onClick={() => onLink(thread.id, { ack: true })}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] font-medium text-[var(--fg)] hover:bg-[var(--canvas-subtle)]"
      >
        No change needed
      </button>
    </div>
  );
}
