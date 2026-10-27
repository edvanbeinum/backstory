"use client";

import { useEffect } from "react";

import type { StepAt } from "@/lib/flows/rows";
import type { PullRequestInfo, ReviewThread } from "@/lib/types";
import { ReviewThreadCard } from "./ReviewThreadCard";

/**
 * The Comments tab: every thread as a read-only card, oldest first. Nothing
 * has to be picked to be read. One thread is focused, for links, marks and
 * `j`/`k`: its card is outlined, and brought into view whenever focus is
 * asked for.
 */
export function Comments({
  threads,
  focusedId,
  focusAsk,
  onFocus,
  fileComponents,
  threadSteps,
  onOpenStep,
  pr,
}: {
  threads: ReviewThread[];
  focusedId: string | null;
  /** Focus asked for by a link, a mark or j/k */
  focusAsk: { id: string; at: number } | null;
  /** A card was clicked into */
  onFocus: (id: string) => void;
  /** Each changed file's component, from the map */
  fileComponents: Record<string, string> | null;
  /** The flow step each thread's line is on, where one is */
  threadSteps: Map<string, StepAt>;
  /** Open a step in the story */
  onOpenStep: (at: StepAt) => void;
  pr: PullRequestInfo | null;
}) {
  useEffect(() => {
    if (!focusAsk) return;
    document
      .getElementById(`comment-${focusAsk.id}`)
      ?.scrollIntoView({ block: "start" });
  }, [focusAsk]);

  return (
    <div className="space-y-4 pt-1">
      {threads.map((thread, i) => {
        const component = thread.path
          ? (fileComponents?.[thread.path] ?? null)
          : null;
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
            </header>
            <div className="space-y-2 p-2">
              <ReviewThreadCard
                thread={thread}
                pr={pr}
                showContext
                defaultCollapsed={false}
                highlighted={thread.id === focusedId}
              />
              {at && (
                <p className="comment-story">
                  ⇄ On flow {at.flow}, at {at.label} ·{" "}
                  <button
                    type="button"
                    className="text-[var(--accent)] hover:underline"
                    onClick={() => onOpenStep(at)}
                  >
                    open in the story
                  </button>
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
