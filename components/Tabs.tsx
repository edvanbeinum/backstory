"use client";

import type { Tab } from "@/lib/url";
import type { ReviewThread } from "@/lib/types";

/**
 * Story, Files changed and Comments, as a pull request's tabs. Comments shows
 * only when the pull request has threads.
 */
export function Tabs({
  tab,
  onTab,
  fileCount,
  threads,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  fileCount: number | null;
  threads: ReviewThread[];
}) {
  const button = (id: Tab, children: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className="tab"
      onClick={() => onTab(id)}
    >
      {children}
    </button>
  );
  return (
    <div role="tablist" className="tabs">
      {button("story", "Story")}
      {button(
        "files",
        <>
          Files changed
          {fileCount !== null && <span className="counter">{fileCount}</span>}
        </>,
      )}
      {threads.length > 0 &&
        button(
          "comments",
          <>
            Comments <span className="counter">{threads.length}</span>
          </>,
        )}
    </div>
  );
}
