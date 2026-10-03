"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { anchorThreads } from "@/lib/anchor";
import { anchorNotes, draftNote } from "@/lib/feedback";
import type {
  ApiError,
  CommitSummary,
  DiffFile as DiffFileType,
  FileViewResponse,
  Note,
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
import { NoteCard, NoteComposer } from "./NoteCard";
import { Badge, copyToClipboard, CopyButton, Spinner } from "./ui";
import type { NotesApi } from "./useNotes";

/** A flow step anchored on a line: its row key, and the chip to show. */
export interface FlowMark {
  key: string;
  chip: string;
  was: boolean;
}

export interface FileMarks {
  old: Map<number, FlowMark[]>;
  new: Map<number, FlowMark[]>;
}

const NO_MARKS: FlowMark[] = [];

/** The line a note is being written on. */
interface NoteTarget {
  side: "old" | "new";
  line: number;
  quote: string;
}

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
  notes = null,
  noteRev = null,
  fileNotes = [],
  marks = null,
  component = null,
  linked = false,
}: {
  file: DiffFileType;
  threads: ReviewThread[];
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  /** Set when this diff takes notes */
  notes?: NotesApi | null;
  /** The change a note written here is left on */
  noteRev?: string | null;
  /** This file's notes, on this change */
  fileNotes?: Note[];
  /** Flow steps anchored in this file */
  marks?: FileMarks | null;
  /** The C4 component this file belongs to */
  component?: string | null;
  /** Its component is hovered on the map */
  linked?: boolean;
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

  // Anchoring survives only to mark where the comment you're reading points.
  // The comments themselves live in the spine and the response panel; the
  // diff column is the diff.
  const { byNewLine, byOldLine } = useMemo(
    () => anchorThreads(shown, threads),
    [shown, threads],
  );

  const anchoredNotes = useMemo(
    () => anchorNotes(shown, fileNotes),
    [shown, fileNotes],
  );
  const [drafting, setDrafting] = useState<NoteTarget | null>(null);

  const saveNew = (target: NoteTarget, body: string) => {
    if (!notes || !noteRev) return;
    notes.save(
      draftNote({
        rev: noteRev,
        path: file.path,
        side: target.side,
        line: target.line,
        quote: target.quote,
        body,
      }),
    );
    setDrafting(null);
  };

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

  // Which line-number cell just copied its `path:line` reference — keyed by
  // hunk/line/side so exactly one cell shows the confirmation tick.
  const [copiedLine, setCopiedLine] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLineRef = useCallback(
    async (key: string, line: number) => {
      if (await copyToClipboard(`${file.path}:${line}`)) {
        setCopiedLine(key);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopiedLine(null), 1200);
      }
    },
    [file.path],
  );
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Expanding a 2,000-line file would otherwise dump you at the top of it with
  // the actual change somewhere far below. Put the first change back on screen.
  useEffect(() => {
    if (!showWhole || !whole || wholeLoading) return;
    const target = bodyRef.current?.querySelector(
      "tr.line-add, tr.line-del",
    );
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [showWhole, whole, wholeLoading]);

  // A flow step outside the hunks on screen asks for its line: open the whole
  // file. The flow view scrolls to the line once its anchor renders.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const { path } = (event as CustomEvent<{ path: string }>).detail;
      if (path !== file.newPath && path !== file.oldPath) return;
      setCollapsed(false);
      if (!canViewWhole) return;
      setShowWhole(true);
      if (!whole && !wholeLoading) void loadWhole();
    };
    window.addEventListener("differ:reveal", onReveal);
    return () => window.removeEventListener("differ:reveal", onReveal);
  }, [file.newPath, file.oldPath, canViewWhole, whole, wholeLoading, loadWhole]);

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
      className={`rounded-md border border-[var(--border)] bg-[var(--canvas)] ${linked ? "file-linked" : ""}`}
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

        <CopyButton
          value={file.path}
          label=""
          title="Copy file path"
          variant="invisible"
          className="!px-1"
        />

        {component && <span className="file-owner">{component}</span>}

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
                        hunkIndex={hunkIndex}
                        // In whole-file mode the single hunk spans the file,
                        // so its @@ header is noise rather than a landmark.
                        showHunkHeader={!showWhole}
                        byNewLine={byNewLine}
                        byOldLine={byOldLine}
                        repo={repo}
                        pr={pr}
                        commit={commit}
                        focusedThreadId={focusedThreadId}
                        filePath={file.path}
                        copiedLine={copiedLine}
                        onCopyLine={copyLineRef}
                        notes={notes}
                        notesByNewLine={anchoredNotes.byNewLine}
                        notesByOldLine={anchoredNotes.byOldLine}
                        drafting={drafting}
                        onDraft={setDrafting}
                        onSaveNew={saveNew}
                        marks={marks}
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

          {/* A note whose line has moved out of view or changed. Kept in
              sight, never dropped: it's still something you asked for. */}
          {notes && anchoredNotes.unanchored.length > 0 && (
            <div className="space-y-2 border-t border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-2 last:rounded-b-md">
              {anchoredNotes.unanchored.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onSave={notes.save}
                  onRemove={notes.remove}
                  onTick={notes.tick}
                  context={
                    <>
                      {note.side === "old" ? "Removed line" : "Line"}{" "}
                      {note.line} isn&apos;t in the diff as shown — it may have
                      changed since {note.sentAt !== null ? "you sent this" : "you wrote this"}.
                      {note.quote !== null && (
                        <code className="mono mt-1 block truncate text-[var(--fg)]">
                          {note.quote}
                        </code>
                      )}
                    </>
                  }
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
  hunkIndex,
  showHunkHeader = true,
  byNewLine,
  byOldLine,
  repo,
  pr,
  commit,
  focusedThreadId,
  filePath,
  copiedLine,
  onCopyLine,
  notes,
  notesByNewLine,
  notesByOldLine,
  drafting,
  onDraft,
  onSaveNew,
  marks,
}: {
  hunk: DiffFileType["hunks"][number];
  hunkIndex: number;
  showHunkHeader?: boolean;
  byNewLine: Map<number, ReviewThread[]>;
  byOldLine: Map<number, ReviewThread[]>;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  filePath: string;
  copiedLine: string | null;
  onCopyLine: (key: string, line: number) => void;
  notes: NotesApi | null;
  notesByNewLine: Map<number, Note[]>;
  notesByOldLine: Map<number, Note[]>;
  drafting: NoteTarget | null;
  onDraft: (target: NoteTarget | null) => void;
  onSaveNew: (target: NoteTarget, body: string) => void;
  marks: FileMarks | null | undefined;
}) {
  // Clicking a line number copies the editor-style "path:line" reference —
  // the thing you paste into a terminal, an editor, or a review reply. The
  // cell briefly shows a tick instead of its number as confirmation.
  const numCell = (line: number | null, side: "old" | "new") => {
    if (line === null) return <td className="diff-num" />;
    const key = `${hunkIndex}:${side}:${line}`;
    return (
      <td
        className="diff-num diff-num-copy"
        title={`Copy ${filePath}:${line}`}
        onClick={() => onCopyLine(key, line)}
      >
        {copiedLine === key ? "✓" : line}
      </td>
    );
  };
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

        // A removed line only exists on the old side; everything else is
        // noted where it lives now.
        const target: NoteTarget | null =
          line.type === "del"
            ? line.oldNo != null
              ? { side: "old", line: line.oldNo, quote: line.content }
              : null
            : line.newNo != null
              ? { side: "new", line: line.newNo, quote: line.content }
              : null;
        const lineNotes = target
          ? ((target.side === "old" ? notesByOldLine : notesByNewLine).get(
              target.line,
            ) ?? [])
          : [];
        const isDrafting =
          target !== null &&
          drafting?.side === target.side &&
          drafting.line === target.line;

        // A removed step sits on its old line; every other step on its new
        // one. An unchanged line has both, so look on both sides.
        const lineMarks = marks
          ? [
              ...(line.type !== "add" && line.oldNo != null
                ? (marks.old.get(line.oldNo) ?? NO_MARKS)
                : NO_MARKS),
              ...(line.type !== "del" && line.newNo != null
                ? (marks.new.get(line.newNo) ?? NO_MARKS)
                : NO_MARKS),
            ]
          : NO_MARKS;

        return (
          <Fragment key={index}>
            <tr
              className={`${
                line.type === "add"
                  ? "line-add"
                  : line.type === "del"
                    ? "line-del"
                    : ""
              } ${
                threads.some((t) => t.id === focusedThreadId)
                  ? "line-anchored"
                  : ""
              }`}
              data-old-line={line.oldNo ?? undefined}
              data-new-line={line.newNo ?? undefined}
              data-flow-steps={
                lineMarks.length > 0 ? lineMarks.map((m) => m.key).join(" ") : undefined
              }
            >
              {numCell(line.oldNo, "old")}
              {numCell(line.newNo, "new")}
              <td className="diff-marker">
                <span className={notes && target ? "diff-marker-text" : ""}>
                  {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
                </span>
                {notes && target && (
                  <button
                    type="button"
                    className="note-add"
                    title={`Add a note on ${filePath}:${target.line}`}
                    aria-label="Add a note on this line"
                    onClick={() => onDraft(target)}
                  >
                    +
                  </button>
                )}
              </td>
              {lineMarks.length > 0 ? (
                <td className="diff-code">
                  <span dangerouslySetInnerHTML={{ __html: line.html ?? "" }} />
                  {lineMarks.map((m) => (
                    <em key={m.key} className={`flow-chip ${m.was ? "was" : ""}`}>
                      {m.chip}
                    </em>
                  ))}
                </td>
              ) : (
                <td
                  className="diff-code"
                  dangerouslySetInnerHTML={{ __html: line.html ?? "" }}
                />
              )}
            </tr>

            {notes && (lineNotes.length > 0 || isDrafting) && (
              <tr className="note-row">
                <td colSpan={4}>
                  <div className="space-y-2">
                    {lineNotes.map((note) => (
                      <NoteCard
                        key={note.id}
                        note={note}
                        onSave={notes.save}
                        onRemove={notes.remove}
                        onTick={notes.tick}
                      />
                    ))}
                    {isDrafting && target && (
                      <NoteComposer
                        onCancel={() => onDraft(null)}
                        onSave={(body) => onSaveNew(target, body)}
                      />
                    )}
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
