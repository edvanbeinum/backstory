"use client";

import { useMemo, useState } from "react";

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
  ChevronDownIcon,
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
  const link = thread?.response.commit;
  const linked = link && !link.missing ? link.sha : null;
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
  const link = thread?.response.commit;
  if (link && !link.missing) return link.sha;
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
  onSelectThread,
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
  /** Hand a comment to the response panel, which owns answering it. */
  onSelectThread?: (threadId: string) => void;
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
      threads.filter(
        (t) => t.response.commit && !t.response.commit.missing &&
          t.response.commit.sha === rev,
      ),
    [threads, rev],
  );

  return (
    <div className="space-y-3">
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
          {/* A commit picked from the dropdown isn't one of the offered
              options, but still needs to read as the current selection. */}
          {!options.some((o) => o.rev === rev) && commit && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-subtle)] px-2.5 py-[3px] text-[11px] font-medium text-[var(--accent)]">
              <GitCommitIcon size={12} />
              {commit.shortSha}
            </span>
          )}

        <CommitPicker session={session} rev={rev} onRevChange={onRevChange} />
      </div>

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
        onSelectThread={onSelectThread}
      />
    </div>
  );
}

/**
 * Browse to any commit on the branch.
 *
 * differ used to carry a whole second rail for this, competing with the
 * comment list for the same column. Reading your own commits before you push
 * is still a real workflow — it's what differ was built for — but it's a
 * thing you reach for, not a thing you need on screen at all times. So it
 * lives here, next to the other things the diff column can show.
 */
function CommitPicker({
  session,
  rev,
  onRevChange,
}: {
  session: SessionResponse;
  rev: string;
  onRevChange: (rev: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const candidates = useMemo(
    () => [...session.commits, ...session.history.slice(0, 30)],
    [session],
  );

  if (candidates.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-[3px] text-[11px] font-medium text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <GitCommitIcon size={12} />
        A commit…
        <ChevronDownIcon size={10} />
      </button>

      {open && (
        <ul className="absolute left-0 top-full z-40 mt-1 max-h-80 w-[26rem] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-[var(--overlay-shadow)]">
          {candidates.map((candidate) => {
            // The push boundary is the one distinction worth keeping from the
            // old rail: what you can still rewrite, and what's already out.
            const pushed = !session.commits.some(
              (c) => c.sha === candidate.sha,
            );
            return (
              <li key={candidate.sha}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    // mousedown: onBlur would close the list before a click
                    event.preventDefault();
                    setOpen(false);
                    onRevChange(candidate.sha);
                  }}
                  className={`flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-[var(--canvas-subtle)] ${
                    candidate.sha === rev ? "bg-[var(--accent-subtle)]" : ""
                  }`}
                >
                  <span className="mono shrink-0 text-[11px] text-[var(--fg-muted)]">
                    {candidate.shortSha}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate text-[11px] ${
                      pushed ? "text-[var(--fg-muted)]" : "text-[var(--fg)]"
                    }`}
                  >
                    {candidate.subject}
                  </span>
                  {pushed && (
                    <span className="shrink-0 text-[10px] text-[var(--fg-subtle)]">
                      pushed
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </span>
  );
}
