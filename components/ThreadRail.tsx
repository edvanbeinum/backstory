"use client";

import { useMemo, useState } from "react";

import type { ReviewThread } from "@/lib/types";
import { CheckIcon, CommentIcon, DotFillIcon } from "./icons";

type Filter = "open" | "all";

export function ThreadRail({
  threads,
  anchoredIds,
  focusedThreadId,
  onFocus,
}: {
  threads: ReviewThread[];
  /** Thread ids that land on a line of the diff currently on screen */
  anchoredIds: Set<string>;
  focusedThreadId: string | null;
  onFocus: (thread: ReviewThread) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");

  const openCount = threads.filter((t) => !t.isResolved).length;
  const visible = useMemo(
    () => (filter === "open" ? threads.filter((t) => !t.isResolved) : threads),
    [threads, filter],
  );

  const byFile = useMemo(() => {
    const groups = new Map<string, ReviewThread[]>();
    for (const thread of visible) {
      const key = thread.path ?? "General";
      groups.set(key, [...(groups.get(key) ?? []), thread]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  if (threads.length === 0) return null;

  return (
    <nav aria-label="Review threads" className="border-t border-[var(--border)]">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Review threads
        </h2>
        <button
          type="button"
          onClick={() => setFilter(filter === "open" ? "all" : "open")}
          className="text-[11px] text-[var(--accent)] hover:underline"
        >
          {filter === "open" ? `${openCount} open` : `all ${threads.length}`}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-[var(--fg-muted)]">
          Every thread is resolved.
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
                const anchored = anchoredIds.has(thread.id);
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => onFocus(thread)}
                      className={`flex w-full items-start gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
                        focusedThreadId === thread.id
                          ? "border-[var(--attention)] bg-[var(--accent-subtle)]"
                          : "border-transparent hover:bg-[var(--canvas-subtle)]"
                      }`}
                    >
                      <span className="mt-[3px] shrink-0">
                        {thread.isResolved ? (
                          <CheckIcon
                            size={12}
                            className="text-[var(--done)]"
                          />
                        ) : anchored ? (
                          <DotFillIcon
                            size={12}
                            className="text-[var(--attention)]"
                          />
                        ) : (
                          <CommentIcon
                            size={12}
                            className="text-[var(--fg-subtle)]"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] leading-5">
                          {stripMarkdown(first?.body ?? "")}
                        </span>
                        <span className="text-[11px] text-[var(--fg-muted)]">
                          {first?.author}
                          {thread.line != null && ` · line ${thread.line}`}
                          {anchored && " · in this diff"}
                        </span>
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

/** Enough markdown stripping for a one-line preview. */
function stripMarkdown(body: string): string {
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
