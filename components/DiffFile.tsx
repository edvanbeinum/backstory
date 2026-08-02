"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { anchorThreads } from "@/lib/anchor";
import type {
  ApiError,
  CommitSummary,
  DiffFile as DiffFileType,
  FileViewResponse,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  UnfoldIcon,
} from "./icons";
import { ReviewThreadCard } from "./ReviewThreadCard";
import { Badge, Spinner } from "./ui";

const STATUS_TONE: Record<string, string> = {
  added: "text-[var(--success)]",
  deleted: "text-[var(--danger)]",
  renamed: "text-[var(--done)]",
  copied: "text-[var(--done)]",
  modified: "text-[var(--fg-muted)]",
};

export function DiffFile({
  file,
  threads,
  repo,
  pr,
  commit,
  focusedThreadId,
}: {
  file: DiffFileType;
  threads: ReviewThread[];
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [whole, setWhole] = useState<FileViewResponse | null>(null);
  const [wholeLoading, setWholeLoading] = useState(false);
  const [wholeError, setWholeError] = useState<string | null>(null);
  const [showWhole, setShowWhole] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The whole-file response is just a DiffFile with one enormous hunk, so it
  // drops straight into the same rendering path.
  const shown = showWhole && whole ? whole.file : file;

  const { byNewLine, byOldLine, unanchored } = useMemo(
    () => anchorThreads(shown, threads),
    [shown, threads],
  );

  const anchoredCount = threads.length - unanchored.length;
  const canViewWhole =
    !file.isBinary && file.hunks.length > 0 && commit !== null;

  const loadWhole = useCallback(async () => {
    if (!commit) return;
    setWholeLoading(true);
    setWholeError(null);
    try {
      const params = new URLSearchParams({
        repo: repo.root,
        rev: commit.sha,
      });
      // Both names for a rename, so git can still pair the blobs up; the last
      // one is treated as the file's identity.
      for (const p of [file.oldPath, file.newPath]) {
        if (p) params.append("path", p);
      }
      if (!file.oldPath && !file.newPath) params.append("path", file.path);
      const response = await fetch(`/api/file?${params}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data as ApiError).error);
      setWhole(data as FileViewResponse);
    } catch (err) {
      setWholeError(err instanceof Error ? err.message : String(err));
      setShowWhole(false);
    } finally {
      setWholeLoading(false);
    }
  }, [commit, repo.root, file]);

  const toggleWhole = () => {
    if (showWhole) {
      setShowWhole(false);
      return;
    }
    setShowWhole(true);
    if (!whole) void loadWhole();
  };

  // Expanding a 2,000-line file would otherwise dump you at the top of it with
  // the actual change somewhere far below. Put the first change back on screen.
  useEffect(() => {
    if (!showWhole || !whole || wholeLoading) return;
    const target = bodyRef.current?.querySelector(
      "tr.line-add, tr.line-del",
    );
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [showWhole, whole, wholeLoading]);

  // A different commit means a different file revision; drop the cached view.
  useEffect(() => {
    setWhole(null);
    setShowWhole(false);
    setWholeError(null);
  }, [commit?.sha, file.path]);

  return (
    <section
      id={`file-${encodeURIComponent(file.path)}`}
      // No overflow-hidden here: it would make this section the sticky
      // header's containing scrollport, and since the section itself never
      // scrolls, the filename would never actually stick. Corners are
      // rounded per-edge instead.
      className="rounded-md border border-[var(--border)] bg-[var(--canvas)]"
      // Jump targets must clear the sticky app bar, or FileNav's scroll
      // lands the section header underneath it.
      style={{ scrollMarginTop: "calc(var(--header-height, 0px) + 8px)" }}
    >
      {/* last:rounded-b-md covers the collapsed state, where the header is
          the card's only child and owns the bottom corners too. */}
      <header className="sticky top-[var(--header-height,0px)] z-10 flex items-center gap-2 rounded-t-md border-b border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2 last:rounded-b-md">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          {collapsed ? (
            <ChevronRightIcon size={14} />
          ) : (
            <ChevronDownIcon size={14} />
          )}
        </button>

        <span className="mono min-w-0 flex-1 truncate text-[12px] font-semibold">
          {file.status === "renamed" && file.oldPath ? (
            <>
              <span className="text-[var(--fg-muted)]">{file.oldPath}</span>
              <span className="px-1 text-[var(--fg-subtle)]">→</span>
              {file.newPath}
            </>
          ) : (
            file.path
          )}
        </span>

        {anchoredCount > 0 && (
          <Badge tone="attention">
            {anchoredCount} {anchoredCount === 1 ? "comment" : "comments"}
          </Badge>
        )}

        <span className={`text-[11px] ${STATUS_TONE[file.status] ?? ""}`}>
          {file.status}
        </span>

        <span className="mono shrink-0 text-[11px]">
          <span className="text-[var(--success)]">+{file.additions}</span>{" "}
          <span className="text-[var(--danger)]">−{file.deletions}</span>
        </span>

        {canViewWhole && !collapsed && (
          <button
            type="button"
            onClick={toggleWhole}
            title={
              showWhole
                ? "Show only the changed hunks"
                : "Show the whole file with this change in place"
            }
            className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-[3px] text-[11px] font-medium transition-colors ${
              showWhole
                ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--canvas)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
            }`}
          >
            {wholeLoading ? (
              <Spinner className="!h-3 !w-3" />
            ) : showWhole ? (
              <UnfoldIcon size={12} />
            ) : (
              <FileIcon size={12} />
            )}
            {showWhole ? "Diff only" : "View file"}
          </button>
        )}
      </header>

      {!collapsed && (
        <>
          {file.isBinary ? (
            <p className="px-3 py-4 text-center text-[12px] text-[var(--fg-muted)]">
              Binary file not shown
            </p>
          ) : file.hunks.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-[var(--fg-muted)]">
              {file.status === "renamed"
                ? `File renamed without changes${
                    file.similarity ? ` (${file.similarity}% similar)` : ""
                  }`
                : "No content changes"}
            </p>
          ) : (
            <div className="overflow-x-auto last:rounded-b-md" ref={bodyRef}>
              {showWhole && wholeLoading && !whole ? (
                <p className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--fg-muted)]">
                  <Spinner /> Loading the whole file…
                </p>
              ) : (
                <table className="diff-table">
                  <tbody>
                    {shown.hunks.map((hunk, hunkIndex) => (
                      <HunkRows
                        key={hunkIndex}
                        hunk={hunk}
                        // In whole-file mode the single hunk spans the file,
                        // so its @@ header is noise rather than a landmark.
                        showHunkHeader={!showWhole}
                        byNewLine={byNewLine}
                        byOldLine={byOldLine}
                        repo={repo}
                        pr={pr}
                        commit={commit}
                        focusedThreadId={focusedThreadId}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {wholeError && (
            <p className="border-t border-[var(--border-muted)] px-3 py-2 text-[12px] text-[var(--danger)]">
              Couldn&apos;t load the full file: {wholeError}
            </p>
          )}

          {showWhole && whole && (
            <p className="border-t border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] text-[var(--fg-muted)] last:rounded-b-md">
              Whole file — {whole.lineCount.toLocaleString()} lines
              {whole.highlightSkipped && " · too large to highlight"}
              {whole.file.truncated && " · truncated"}
            </p>
          )}

          {shown.truncated && !showWhole && (
            <p className="border-t border-[var(--border-muted)] px-3 py-2 text-[12px] text-[var(--attention)]">
              This file is too large to render in full — showing the first
              chunk only.
            </p>
          )}

          {unanchored.length > 0 && (
            <div className="space-y-2 border-t border-[var(--border-muted)] bg-[var(--canvas-subtle)] p-2 last:rounded-b-md">
              <p className="text-[11px] text-[var(--fg-muted)]">
                {unanchored.length} comment
                {unanchored.length === 1 ? "" : "s"} on this file that
                {unanchored.length === 1 ? " doesn't" : " don't"} land on a line
                in this diff:
              </p>
              {unanchored.map((thread) => (
                <ReviewThreadCard
                  key={thread.id}
                  thread={thread}
                  repo={repo}
                  pr={pr}
                  commit={commit}
                  showContext
                  defaultCollapsed
                  highlighted={focusedThreadId === thread.id}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HunkRows({
  hunk,
  showHunkHeader = true,
  byNewLine,
  byOldLine,
  repo,
  pr,
  commit,
  focusedThreadId,
}: {
  hunk: DiffFileType["hunks"][number];
  showHunkHeader?: boolean;
  byNewLine: Map<number, ReviewThread[]>;
  byOldLine: Map<number, ReviewThread[]>;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
}) {
  return (
    <>
      {showHunkHeader && (
        <tr className="line-hunk">
          <td colSpan={4} className="mono">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{" "}
            @@ {hunk.header}
          </td>
        </tr>
      )}

      {hunk.lines.map((line, index) => {
        const threads = [
          ...(line.newNo != null ? (byNewLine.get(line.newNo) ?? []) : []),
          ...(line.oldNo != null && line.type === "del"
            ? (byOldLine.get(line.oldNo) ?? [])
            : []),
        ];

        return (
          <Fragment key={index}>
            <tr
              className={`${
                line.type === "add"
                  ? "line-add"
                  : line.type === "del"
                    ? "line-del"
                    : ""
              } ${threads.length > 0 ? "line-anchored" : ""}`}
            >
              <td className="diff-num">{line.oldNo ?? ""}</td>
              <td className="diff-num">{line.newNo ?? ""}</td>
              <td className="diff-marker">
                {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
              </td>
              <td
                className="diff-code"
                dangerouslySetInnerHTML={{ __html: line.html ?? "" }}
              />
            </tr>

            {threads.map((thread) => (
              <tr key={thread.id}>
                <td colSpan={4} className="bg-[var(--canvas-subtle)] p-2">
                  <ReviewThreadCard
                    thread={thread}
                    repo={repo}
                    pr={pr}
                    commit={commit}
                    highlighted={focusedThreadId === thread.id}
                  />
                </td>
              </tr>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}
