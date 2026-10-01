"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, CommentIcon } from "./icons";

export type ColumnTab = "flows" | "comments";

const WIDTH_KEY = "differ.columnWidth";
const DEFAULT_WIDTH = 44;
const MIN_WIDTH = 28;
const MAX_WIDTH = 64;

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

const FlowsIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3 2v12M13 2v12M3 5h9M12 5l-2-1.5M12 5l-2 1.5M13 10H4M4 10l2-1.5M4 10l2 1.5" />
  </svg>
);

/**
 * The diagram column, left of the diff: the flows and, when the pull request
 * has them, the review comments, as tabs. Resizable; its width is this
 * viewer's own, kept in browser storage. Below xl it stacks above the diff,
 * collapsed, so the diff keeps the window.
 */
export function SideColumn({
  tab,
  onTab,
  flowCount,
  commentCount,
  showComments,
  header,
  flows,
  comments,
}: {
  tab: ColumnTab;
  onTab: (tab: ColumnTab) => void;
  flowCount: number | null;
  commentCount: number;
  showComments: boolean;
  /** Above the tabs: the map strip */
  header?: React.ReactNode;
  flows: React.ReactNode;
  comments: React.ReactNode;
}) {
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const columnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(WIDTH_KEY));
      if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) setWidth(stored);
    } catch {
      // Storage blocked: the default width will do.
    }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    const row = columnRef.current?.parentElement;
    if (!row) return;
    event.preventDefault();
    setDragging(true);
    const box = row.getBoundingClientRect();
    let latest = DEFAULT_WIDTH;
    const move = (e: PointerEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ((e.clientX - box.left) / box.width) * 100));
      setWidth(latest);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(Math.round(latest * 10) / 10));
      } catch {
        // As above.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const tabs = (
    <div role="tablist" className="flex gap-2 border-b border-[var(--border-muted)]">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "flows"}
        className="flow-tab"
        onClick={() => {
          onTab("flows");
          setOpen(true);
        }}
      >
        <FlowsIcon />
        Flows
        {flowCount !== null && <span className="counter">{flowCount}</span>}
      </button>
      {showComments && (
        <button
          type="button"
          role="tab"
          aria-selected={tab === "comments"}
          className="flow-tab"
          onClick={() => {
            onTab("comments");
            setOpen(true);
          }}
        >
          <CommentIcon size={16} />
          Comments <span className="counter">{commentCount}</span>
        </button>
      )}
      {!wide && (
        <button
          type="button"
          className="ml-auto self-center p-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </button>
      )}
    </div>
  );

  const body = (
    <div className="space-y-3">
      {header}
      {tabs}
      {(wide || open) && (tab === "flows" ? flows : comments)}
    </div>
  );

  if (!wide) return <div className="min-w-0">{body}</div>;

  return (
    <>
      <div
        ref={columnRef}
        data-column-scroll
        className="thin-scroll sticky min-w-0 shrink-0 overflow-y-auto"
        style={{
          width: `${width}%`,
          top: "calc(var(--header-height, 0px) + 1rem)",
          // Always the window's height, not the content's: the map overlay
          // opens over the column and must not be clipped by it.
          height: "calc(100vh - var(--header-height, 0px) - 2rem)",
        }}
      >
        {body}
      </div>
      <div
        className="col-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the column"
        title="Drag to resize"
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          try {
            window.localStorage.removeItem(WIDTH_KEY);
          } catch {
            // As above.
          }
        }}
      />
    </>
  );
}
