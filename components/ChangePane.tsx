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
import type { FileMarks } from "./DiffFile";
import { DiffView } from "./DiffView";
import { CommitPicker } from "./CommitPicker";
import { FeedbackBar } from "./FeedbackBar";
import { useNotes } from "./useNotes";
import { useOutbox } from "./useOutbox";
import { useReview } from "./useReview";
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
  // Every change you said answers this comment stays offered, so returning
  // to a handled comment can show any of them.
  for (const link of thread?.response.commits ?? []) {
    if (link.missing) continue;
    const linked = link.sha;
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
 * Which change to show when you move to a comment — or `null` for "leave the
 * diff exactly where it is".
 *
 * A comment you linked reopens on the change you linked it to. That isn't a
 * guess; it's the answer you already gave, played back.
 *
 * An unlinked comment moves nothing. It used to fall back to the whole branch
 * diff, which threw away the commit you were reading the moment you stepped
 * to the next comment — precisely when you were most likely to want it still
 * on screen. differ has no idea which change answers an unhandled comment,
 * and behaving as though it might is worse than doing nothing.
 */
export function openingChangeFor(
  thread: ReviewThread | null,
): string | null {
  return thread?.response.commits.find((c) => !c.missing)?.sha ?? null;
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
  pushed,
  reviewTick,
  flowMarks = null,
  fileComponents = null,
  hoveredComponent = null,
  layout = "code",
  onLayout,
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
  pushed: boolean;
  /** Moves when an agent starts or stops waiting, or a round is queued or collected */
  reviewTick: number;
  /** The selected flow's steps, anchored on the diff's lines */
  flowMarks?: Map<string, FileMarks> | null;
  /** Each file's C4 component, from the map */
  fileComponents?: Record<string, string> | null;
  hoveredComponent?: string | null;
  /** "diagrams" hides the diff: the flows lead, the code is opened from them */
  layout?: "diagrams" | "code";
  /** Offered only where there are flows to lead with */
  onLayout?: ((layout: "diagrams" | "code") => void) | null;
}) {
  const notes = useNotes(session.repo.root);
  const review = useReview(session.repo.root, reviewTick);
  const outbox = useOutbox(session.repo.root, reviewTick, notes.reload);

  // The change on screen as a note records it: a commit by its full sha,
  // which is what stays comparable across views. Null until the diff showing
  // is this change's — for a moment after switching it's still the last one,
  // and a note left then would be filed against the wrong change.
  const noteRev = useMemo(() => {
    if (!diff || diff.rev !== rev) return null;
    if (rev === WORKING_REV || rev === BRANCH_REV) return rev;
    if (commit && /^[0-9a-f]{40}$/.test(commit.sha)) return commit.sha;
    return /^[0-9a-f]{40}$/.test(rev) ? rev : null;
  }, [diff, rev, commit]);

  const options = useMemo(
    () => changesFor(thread, session),
    [thread, session],
  );

  /**
   * Any commit on the branch, so the diff column isn't limited to the three
   * chips. Reading your own commits before pushing is what differ was built
   * for; it just no longer needs a rail of its own to do it.
   */
  const commitCandidates = useMemo(
    () => [...session.commits, ...session.history],
    [session],
  );

  // How many comments this change answers — the reverse lookup that was
  // missing: given a commit, which review comments land in it?
  const landing = useMemo(
    () =>
      threads.filter((t) =>
        t.response.commits.some((c) => !c.missing && c.sha === rev),
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

          {commitCandidates.length > 0 && (
            <CommitPicker
              label="A commit…"
              candidates={commitCandidates}
              selected={rev}
              onPick={onRevChange}
              align="left"
            />
          )}
          {onLayout && (
            <span className="seg ml-auto" role="group" aria-label="Layout">
              {(["diagrams", "code"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={layout === l}
                  onClick={() => onLayout(l)}
                  title={
                    l === "diagrams"
                      ? "Lead with the map and the flows; open code from a step"
                      : "The flow beside the full diff"
                  }
                >
                  {l === "diagrams" ? "Diagrams" : "Code"}
                </button>
              ))}
            </span>
          )}
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

      {layout === "code" && (
      <DiffView
        diff={diff}
        loading={loading}
        error={error}
        threads={threads}
        repo={session.repo}
        pr={session.github.pr}
        commit={commit}
        focusedThreadId={focusedThreadId}
        notes={noteRev ? notes : null}
        noteRev={noteRev}
        marks={flowMarks}
        fileComponents={fileComponents}
        hoveredComponent={hoveredComponent}
      />
      )}

      {/* Pinned to the bottom of the window while the diff scrolls, so a
          general note or Send is always a click away. */}
      {/* In either layout: an agent waiting on review must never be invisible. */}
      {(noteRev || notes.notes.length > 0 || review.waiting || review.error) && (
        <div className="sticky bottom-4 z-20">
          <FeedbackBar
            notes={notes}
            noteRev={noteRev}
            diff={noteRev ? diff : null}
            session={session}
            review={review}
            outbox={outbox}
            onRevChange={onRevChange}
          />
        </div>
      )}
    </div>
  );
}
