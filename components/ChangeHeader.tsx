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
import { CommitPicker } from "./CommitPicker";
import { FileDiffIcon, GitCommitIcon, PencilIcon } from "./icons";

interface ChangeOption {
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
function changesFor(
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

  return options;
}

/**
 * Above the tabs: the change picker and the commit's header. Picking a change
 * leaves the focused comment alone.
 */
export function ChangeHeader({
  session,
  rev,
  onRevChange,
  commit,
  diff,
  thread,
  pushed,
}: {
  session: SessionResponse;
  rev: string;
  onRevChange: (rev: string) => void;
  commit: CommitSummary | null;
  diff: DiffResponse | null;
  /** The focused comment, so Uncommitted can say it touches the comment's file */
  thread: ReviewThread | null;
  pushed: boolean;
}) {
  const options = useMemo(() => changesFor(thread, session), [thread, session]);

  /**
   * Any commit on the branch, so the change picked isn't limited to the
   * chips. Reading your own commits before pushing is what Backstory was built
   * for; it just no longer needs a list of its own to do it.
   */
  const commitCandidates = useMemo(
    () => [...session.commits, ...session.history],
    [session],
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

        {commitCandidates.length > 0 && (
          <CommitPicker
            label="A commit…"
            candidates={commitCandidates}
            selected={rev}
            onPick={onRevChange}
            align="left"
          />
        )}
      </div>

      <CommitHeader commit={commit} diff={diff} pushed={pushed} />
    </div>
  );
}
