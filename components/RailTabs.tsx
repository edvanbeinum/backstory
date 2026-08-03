"use client";

import type { RailMode } from "@/lib/url";
import { CommentIcon, GitCommitIcon } from "./icons";

/**
 * Switches the rail between the two jobs differ does: working through review
 * feedback (the default) and reading your own commits before pushing. They
 * were previously stacked in one column, which made the rail hard to read.
 */
export function RailTabs({
  mode,
  onChange,
  commentCount,
  commitCount,
}: {
  mode: RailMode;
  onChange: (mode: RailMode) => void;
  commentCount: number;
  commitCount: number;
}) {
  const tabs: Array<{
    id: RailMode;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
    {
      id: "comments",
      label: "Comments",
      count: commentCount,
      icon: <CommentIcon size={12} />,
    },
    {
      id: "commits",
      label: "Commits",
      count: commitCount,
      icon: <GitCommitIcon size={12} />,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Rail mode"
      className="sticky top-0 z-10 flex gap-1 border-b border-[var(--border)] bg-[var(--canvas)] p-1.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={mode === tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
            mode === tab.id
              ? "bg-[var(--accent-subtle)] text-[var(--accent)]"
              : "text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)]"
          }`}
        >
          {tab.icon}
          {tab.label}
          {tab.count > 0 && (
            <span className="text-[var(--fg-subtle)]">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
