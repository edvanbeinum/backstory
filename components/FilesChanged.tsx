"use client";

import { useEffect, useMemo, useState } from "react";

import { coverage } from "@/lib/flows/coverage";
import { fileFlows, type StepMark, type StepMarks } from "@/lib/flows/rows";
import type { FlowSet } from "@/lib/flows/types";
import type { MapResponse } from "@/lib/map";
import { groupByComponent } from "@/lib/mapGroups";
import type {
  CommitSummary,
  DiffResponse,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { hunkKey } from "./DiffFile";
import { DiffView, type DiffSection } from "./DiffView";
import { jumpToFile } from "./SystemMap";
import type { NotesApi } from "./useNotes";

/** A file, or a line in it, for Files changed to bring up once it renders. */
export interface FilesJump {
  path: string;
  side?: "old" | "new";
  line?: number;
  /** A note to bring up, before its line */
  note?: string;
  /** The view it was asked for, when that's a change still to open */
  view?: string;
  /** When it was asked for, so asking twice jumps twice */
  at: number;
}

/** Ask a file to show a line that's outside the hunks on screen. */
function revealLine(path: string, side: "old" | "new", line: number) {
  window.dispatchEvent(
    new CustomEvent("backstory:reveal", { detail: { path, side, line } }),
  );
}

const sectionFor = (path: string) =>
  document.getElementById(`file-${encodeURIComponent(path)}`);

/** The line, once its file has rendered it. */
const rowFor = (path: string, side: "old" | "new", line: number) =>
  sectionFor(path)?.querySelector<HTMLElement>(
    `tr[data-${side}-line="${line}"]`,
  ) ?? null;

type Filter = "all" | "yourself" | number;

/**
 * Files changed: the whole diff, grouped the way the story reads, by the
 * map's components, with "by path" for the plain list. Once the view is
 * traced, each file says which flows it is on, and the filters narrow to the
 * hunks no flow explains or to one flow's files.
 */
export function FilesChanged({
  view,
  diff,
  loading,
  error,
  threads,
  repo,
  commit,
  focusedThreadId,
  notes,
  noteRev,
  map,
  flowSet,
  marks,
  jump,
  onJumped,
  filterAsk = null,
  onShowOnMap,
  commentNumbers,
  onStep,
  onComment,
}: {
  /** The repo and change on screen */
  view: string;
  diff: DiffResponse | null;
  loading: boolean;
  error: string | null;
  threads: ReviewThread[];
  repo: RepoInfo;
  commit: CommitSummary | null;
  focusedThreadId: string | null;
  notes: NotesApi | null;
  noteRev: string | null;
  map: MapResponse | null;
  flowSet: FlowSet | null;
  /** Every flow's steps, by file */
  marks: Map<string, StepMarks> | null;
  jump: FilesJump | null;
  onJumped: () => void;
  /** A filter to open with, from the story's "read these yourself" */
  filterAsk?: { filter: "yourself"; at: number } | null;
  /** Outline a component on the story's map */
  onShowOnMap: (component: string) => void;
  /** Each thread's number, in the spine's order, for its gutter mark */
  commentNumbers: Map<string, number>;
  /** Open a step's gutter mark in the story */
  onStep: (mark: StepMark) => void;
  /** Open a comment's gutter mark in Comments */
  onComment: (threadId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [byPath, setByPath] = useState(false);
  // A filter names this change's flows, so it doesn't carry to the next one.
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    setFilter("all");
  }
  const [askedAt, setAskedAt] = useState<number | null>(null);
  if (filterAsk && filterAsk.at !== askedAt) {
    setAskedAt(filterAsk.at);
    setFilter(filterAsk.filter);
  }
  // A jump goes to a line the filter may hide.
  const [jumpedAt, setJumpedAt] = useState<number | null>(null);
  if (jump && jump.at !== jumpedAt) {
    setJumpedAt(jump.at);
    setFilter("all");
  }

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const flows = useMemo(
    () => (flowSet ? fileFlows(flowSet, files) : null),
    [flowSet, files],
  );
  /** The hunks no flow explains, by file, as `hunkKey`s */
  const yours = useMemo(() => {
    const out = new Map<string, Set<string>>();
    if (!flowSet) return out;
    for (const h of coverage(flowSet, files)) {
      if (h.onFlow) continue;
      out.set(
        h.file,
        (out.get(h.file) ?? new Set()).add(hunkKey(h.side, h.line)),
      );
    }
    return out;
  }, [flowSet, files]);
  const yoursCount = [...yours.values()].reduce((n, s) => n + s.size, 0);

  const active: Filter =
    !flowSet ||
    (filter === "yourself" && yoursCount === 0) ||
    (typeof filter === "number" && filter > flowSet.flows.length)
      ? "all"
      : filter;
  const shownFiles = files.filter((f) =>
    active === "all"
      ? true
      : active === "yourself"
        ? yours.has(f.path)
        : (() => {
            const on = flows?.get(f.path);
            return Array.isArray(on) && on.includes(active);
          })(),
  );

  const grouped =
    !byPath && map?.status === "ok" && map.nodes.length > 0 ? map : null;
  // The map can name a component it doesn't draw, such as a container
  // dropped for a changed component inside it, which has nothing to outline.
  const drawn = new Set(grouped?.nodes.map((n) => n.name));
  const sections: DiffSection[] = grouped
    ? groupByComponent(shownFiles, grouped.fileComponents, grouped.nodes).map(
        (g) => ({
          key: g.component ?? "\u0000none",
          files: g.files,
          header: (
            <h4 className="files-group">
              {g.component ?? "Not on the map"}
              <small>
                {g.files.length} {g.files.length === 1 ? "file" : "files"} ·{" "}
                <span className="text-[var(--success)]">
                  +{g.files.reduce((n, f) => n + f.additions, 0)}
                </span>
              </small>
              <span className="flex-1" />
              {g.component && drawn.has(g.component) && (
                <button
                  type="button"
                  onClick={() => onShowOnMap(g.component!)}
                  className="text-[12px] font-normal text-[var(--accent)] hover:underline"
                >
                  On the map
                </button>
              )}
            </h4>
          ),
        }),
      )
    : [{ key: "all", files: shownFiles }];

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const chip = (value: Filter, children: React.ReactNode, warn = false) => (
    <button
      type="button"
      aria-pressed={active === value}
      className={`filter-chip ${warn ? "warn" : ""}`}
      onClick={() => setFilter(value)}
    >
      {children}
    </button>
  );
  // The tab mounts, then the diff renders: wait for the file, then the line.
  // A line outside the hunks asks its file to show the whole file first.
  useEffect(() => {
    if (!jump) return;
    let tries = 0;
    let revealed = false;
    const poll = setInterval(() => {
      const { path, side, line, note } = jump;
      let done = false;
      const noteEl = note ? document.getElementById(`note-${note}`) : null;
      if (noteEl) {
        noteEl.scrollIntoView({ block: "center" });
        done = true;
      } else if (side && line !== undefined) {
        const row = rowFor(path, side, line);
        if (row) {
          row.scrollIntoView({ block: "center" });
          row.classList.remove("flash");
          void row.offsetWidth;
          row.classList.add("flash");
          done = true;
        } else if (sectionFor(path) && !revealed) {
          revealLine(path, side, line);
          revealed = true;
        }
      } else {
        done = jumpToFile(path);
      }
      if (!done && ++tries > 50) done = jumpToFile(path) || true;
      if (done) {
        clearInterval(poll);
        onJumped();
      }
    }, 100);
    return () => clearInterval(poll);
  }, [jump, onJumped]);

  return (
    <div className="space-y-3 pt-1">
      {diff && files.length > 0 && (
        <div className="files-filters">
          <span>Show</span>
          {chip("all", `All files · ${files.length}`)}
          {flowSet && yoursCount > 0 && (
            <>
              {chip(
                "yourself",
                `Read these yourself · ${yoursCount} ${yoursCount === 1 ? "hunk" : "hunks"}`,
                true,
              )}
            </>
          )}
          {flowSet?.flows.map((f, i) => (
            <span key={f.id} title={f.trigger}>
              {chip(i + 1, `On flow ${i + 1}`)}
            </span>
          ))}
          <span className="flex-1" />
          <span className="mono">
            <span className="text-[var(--success)]">+{additions}</span>{" "}
            <span className="text-[var(--danger)]">−{deletions}</span>
          </span>
          {map?.status === "ok" && map.nodes.length > 0 && (
            <span className="seg" role="group" aria-label="Group files">
              <button
                type="button"
                aria-pressed={!byPath}
                onClick={() => setByPath(false)}
              >
                By the map
              </button>
              <button
                type="button"
                aria-pressed={byPath}
                onClick={() => setByPath(true)}
              >
                By path
              </button>
            </span>
          )}
        </div>
      )}
      <DiffView
        diff={diff}
        loading={loading}
        error={error}
        threads={threads}
        repo={repo}
        commit={commit}
        focusedThreadId={focusedThreadId}
        notes={notes}
        noteRev={noteRev}
        marks={marks}
        fileComponents={map?.fileComponents ?? null}
        sections={sections}
        flows={flows}
        onlyHunks={active === "yourself" ? yours : null}
        commentNumbers={commentNumbers}
        onStep={onStep}
        onComment={onComment}
      />
    </div>
  );
}
