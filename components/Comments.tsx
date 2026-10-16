"use client";

import { useEffect } from "react";

import type { StepAt } from "@/lib/flows/rows";
import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { CompletionCard } from "./CompletionCard";
import { ResponsePanel } from "./ResponsePanel";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * The Comments tab: every thread as a card, in the spine's order, with what
 * you're doing about it. Nothing has to be picked to be read. One thread is
 * focused, for the spine, `x` and `j`/`k`: its card is outlined, and brought
 * into view whenever focus is asked for.
 */
export function Comments({
  threads,
  focusedId,
  focusAsk,
  onFocus,
  fileComponents,
  threadSteps,
  onOpenStep,
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
  focusedId: string | null;
  /** Focus asked for by a spine square, a link, a mark or j/k */
  focusAsk: { id: string; at: number } | null;
  /** A card was clicked into */
  onFocus: (id: string) => void;
  /** Each changed file's component, from the map */
  fileComponents: Record<string, string> | null;
  /** The flow step each thread's line is on, where one is */
  threadSteps: Map<string, StepAt>;
  /** Open a step in the story */
  onOpenStep: (at: StepAt) => void;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  /** The change on screen — what a link would point at */
  commit: CommitSummary | null;
  branch: string | null;
  commitCandidates?: CommitSummary[];
  onToggleDone: (threadId: string, done: boolean) => void;
  onLinkCommit: (threadId: string, sha: string | null) => void;
  onDraftChange?: (threadId: string, text: string | null) => void;
  onBackToInbox?: () => void;
}) {
  useEffect(() => {
    if (!focusAsk) return;
    document
      .getElementById(`comment-${focusAsk.id}`)
      ?.scrollIntoView({ block: "start" });
  }, [focusAsk]);

  const handled = threads.filter((t) => t.response.done).length;
  const allDone = handled === threads.length;

  return (
    <div className="space-y-4 pt-1">
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

      <div className="comments-progress">
        <span>
          <b>{handled}</b> of {threads.length} handled
        </span>
        <span className="bar" aria-hidden="true">
          <i style={{ width: `${(100 * handled) / threads.length}%` }} />
        </span>
        <span className="text-[var(--fg-muted)]">
          A comment is handled when you tick it; a linked commit never ticks it
          for you.
        </span>
      </div>

      {threads.map((thread, i) => {
        const component = thread.path
          ? (fileComponents?.[thread.path] ?? null)
          : null;
        const done = thread.response.done;
        const at = threadSteps.get(thread.id);
        return (
          <section
            key={thread.id}
            id={`comment-${thread.id}`}
            className="comment-card"
            onClickCapture={() => thread.id !== focusedId && onFocus(thread.id)}
          >
            <header>
              <span className="mono min-w-0 truncate font-semibold">
                {thread.path
                  ? `${thread.path}${thread.line != null ? `:${thread.line}` : ""}`
                  : "Review summary"}
              </span>
              {component && <span className="file-owner">{component}</span>}
              <span className="flex-1" />
              <span className="text-[var(--fg-muted)]">
                Comment {i + 1} of {threads.length}
              </span>
              <span className={`state ${done ? "done" : "open"}`}>
                {done ? "✓ Handled" : "○ To do"}
              </span>
            </header>
            {/* Reading order is the working order: what was said, what you're
                saying back, and only then the tick. */}
            <div className="space-y-2 p-2">
              <ReviewThreadCard
                thread={thread}
                repo={repo}
                pr={pr}
                commit={commit}
                showContext
                defaultCollapsed={false}
                highlighted={thread.id === focusedId}
                hideComposer
              />
              {at && (
                <p className="comment-story">
                  ⇄ On flow {at.flow}, step {at.step} ·{" "}
                  <button
                    type="button"
                    className="text-[var(--accent)] hover:underline"
                    onClick={() => onOpenStep(at)}
                  >
                    open in the story
                  </button>
                </p>
              )}
              <ResponsePanel
                key={thread.id}
                thread={thread}
                repo={repo}
                pr={pr}
                commit={commit}
                commitCandidates={commitCandidates}
                onToggleDone={onToggleDone}
                onLinkCommit={onLinkCommit}
                onDraftChange={onDraftChange}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
