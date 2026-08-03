"use client";

import { useMemo, useState } from "react";

import type { ReviewThread } from "@/lib/types";
import { CheckIcon, CommentIcon, PencilIcon, PinIcon } from "./icons";

type Filter = "open" | "all";

/**
 * The comments rail — the app's primary list.
 *
 * differ began commit-first, with review comments as a second parallel list
 * underneath. In practice the comment is the thing you work on and commits
 * are how you answer it, so this leads and the commit list sits behind a
 * toggle.
 *
 * Each row answers the two questions you actually have: what does it say, and
 * has anything answered it yet.
 */
export function CommentList({
  threads,
  selectedId,
  onSelect,
  workingPaths,
}: {
  threads: ReviewThread[];
  selectedId: string | null;
  onSelect: (thread: ReviewThread) => void;
  /** Paths the working tree touches, for the "uncommitted" answer state */
  workingPaths: Set<string>;
}) {
  const [filter, setFilter] = useState<Filter>("open");

  const openCount = threads.filter((t) => !t.isResolved).length;
  const visible = useMemo(
    () => (filter === "open" ? threads.filter((t) => !t.isResolved) : threads),
    [threads, filter],
  );

  // Threads cluster on a handful of files, so the file heading is worth
  // keeping — it's grouping, not a second hierarchy to navigate.
  const byFile = useMemo(() => {
    const groups = new Map<string, ReviewThread[]>();
    for (const thread of visible) {
      const key = thread.path ?? "General";
      groups.set(key, [...(groups.get(key) ?? []), thread]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  if (threads.length === 0) {
    return (
      <p className="px-3 py-4 text-[12px] text-[var(--fg-muted)]">
        No review comments on this pull request yet.
      </p>
    );
  }

  return (
    <nav aria-label="Review comments">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          {threads.length} {threads.length === 1 ? "comment" : "comments"}
          {openCount > 0 && ` · ${openCount} open`}
        </h2>
        <button
          type="button"
          onClick={() => setFilter(filter === "open" ? "all" : "open")}
          className="text-[11px] text-[var(--accent)] hover:underline"
        >
          {filter === "open" ? "show all" : "open only"}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          Every comment is resolved.
        </p>
      ) : (
        byFile.map(([file, group]) => (
          <div key={file} className="mb-1">
            <p
              className="mono truncate px-3 py-1 text-[11px] text-[var(--fg-subtle)]"
              title={file}
            >
              {file.split("/").pop()}
            </p>
            <ul>
              {group.map((thread) => {
                const first = thread.comments[0];
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(thread)}
                      aria-current={
                        selectedId === thread.id ? "true" : undefined
                      }
                      className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
                        selectedId === thread.id
                          ? "border-[var(--accent)] bg-[var(--accent-subtle)]"
                          : "border-transparent hover:bg-[var(--canvas-subtle)]"
                      }`}
                    >
                      <span className="mt-[3px] shrink-0">
                        {thread.isResolved ? (
                          <CheckIcon size={12} className="text-[var(--done)]" />
                        ) : (
                          <CommentIcon
                            size={12}
                            className="text-[var(--attention)]"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] leading-5">
                          {stripMarkdown(first?.body ?? "")}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-1 text-[11px] text-[var(--fg-muted)]">
                          <span>{first?.author}</span>
                          {thread.line != null && (
                            <span>· line {thread.line}</span>
                          )}
                        </span>
                        <AnswerState
                          thread={thread}
                          workingPaths={workingPaths}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
}

/**
 * What currently answers this comment — a pin reads as decided, an inferred
 * commit as a guess, uncommitted work as in progress, and nothing as an open
 * item. Showing it on the row turns the list into a checklist.
 */
export function AnswerState({
  thread,
  workingPaths,
}: {
  thread: ReviewThread;
  workingPaths: Set<string>;
}) {
  if (thread.pinnedSha && thread.pinnedShaMissing) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--attention)]">
        <PinIcon size={10} />
        <span className="mono">{thread.pinnedSha.slice(0, 7)}</span>
        <span>gone</span>
      </span>
    );
  }
  if (thread.pinnedSha) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--done)]">
        <PinIcon size={10} />
        <span className="mono">{thread.pinnedSha.slice(0, 7)}</span>
        {thread.pinnedShaHealed && (
          <span className="text-[var(--fg-subtle)]">re-matched</span>
        )}
      </span>
    );
  }
  // Uncommitted work on the comment's file is the most current answer there
  // is, even though it has no sha to link to yet.
  if (thread.path && workingPaths.has(thread.path)) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--attention)]">
        <PencilIcon size={10} />
        <span>uncommitted work</span>
      </span>
    );
  }
  if (thread.addressedBySha) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--fg-subtle)]">
        <span>→</span>
        <span className="mono">{thread.addressedBySha.slice(0, 7)}</span>
      </span>
    );
  }
  return (
    <span className="text-[11px] text-[var(--fg-subtle)]">unanswered</span>
  );
}

/** Enough markdown stripping for a one-line preview. */
export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
