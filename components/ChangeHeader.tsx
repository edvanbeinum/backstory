"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { BRANCH_REV, STACK_REV, WORKING_REV } from "@/lib/constants";
import type {
  CommitSummary,
  DiffResponse,
  ReviewThread,
  SessionResponse,
} from "@/lib/types";
import { CommitHeader } from "./CommitHeader";
import { CommitPicker } from "./CommitPicker";
import { requestFetch } from "./fetchBranch";
import { FileDiffIcon, GitCommitIcon, PencilIcon } from "./icons";
import { Spinner } from "./ui";

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
  const { stackStart } = session.github;

  if (session.branchDiff) {
    options.push(
      stackStart
        ? {
            rev: BRANCH_REV,
            label: "This PR",
            hint: `this pull request's changes ${session.branchDiff.label}`,
            icon: <FileDiffIcon size={12} />,
          }
        : {
            rev: BRANCH_REV,
            label: "All changes",
            hint: `everything ${session.branchDiff.label}`,
            icon: <FileDiffIcon size={12} />,
          },
    );
  }

  if (stackStart) {
    options.push({
      rev: STACK_REV,
      label: "Whole stack",
      hint: session.stackDiff
        ? `everything the stack brings ${session.stackDiff.label}`
        : `fetches ${stackStart} from origin, then shows everything the stack brings vs it`,
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
  onFetched,
}: {
  session: SessionResponse;
  rev: string;
  onRevChange: (rev: string) => void;
  commit: CommitSummary | null;
  diff: DiffResponse | null;
  /** The focused comment, so Uncommitted can say it touches the comment's file */
  thread: ReviewThread | null;
  pushed: boolean;
  /** Called after Whole stack fetches the branch the stack starts from, to load the session again */
  onFetched: () => void;
}) {
  const options = useMemo(() => changesFor(thread, session), [thread, session]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<{
    branch: string;
    message: string;
  } | null>(null);
  /**
   * The session a fetch of the stack's start finished on, so the view opens
   * on the stack only once the session after it arrives for the same branch.
   */
  const openStack = useRef<SessionResponse | null>(null);

  useEffect(() => {
    const from = openStack.current;
    if (!from || session === from) return;
    openStack.current = null;
    if (session.stackDiff && session.repo.branch === from.repo.branch)
      onRevChange(STACK_REV);
  }, [session, onRevChange]);

  const fetchStackStart = async () => {
    const { root, branch } = session.repo;
    const { stackStart } = session.github;
    if (!branch || !stackStart) return;
    setFetching(true);
    setFetchError(null);
    try {
      // Fetches the branch with its stack's start as the base, which brings
      // in `origin/<start>` alongside whatever happens to the branch itself.
      await requestFetch(root, branch, stackStart);
      openStack.current = session;
      onFetched();
    } catch (err) {
      setFetchError({
        branch,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setFetching(false);
    }
  };

  const pick = (option: ChangeOption) => {
    if (option.rev === STACK_REV && !session.stackDiff) {
      if (!fetching) void fetchStackStart();
      return;
    }
    onRevChange(option.rev);
  };

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
        {options.map((option) => (
          <button
            key={option.rev}
            type="button"
            title={option.hint}
            onClick={() => pick(option)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
              rev === option.rev
                ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
            }`}
          >
            {option.rev === STACK_REV && fetching ? (
              <Spinner className="!h-3 !w-3" />
            ) : (
              option.icon
            )}
            {option.label}
          </button>
        ))}
        {fetchError?.branch === session.repo.branch && (
          <span className="text-[11px] text-[var(--fg-subtle)]">
            {fetchError.message}
          </span>
        )}
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
