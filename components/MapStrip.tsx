"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { MapEdge, MapNode, MapResponse } from "@/lib/map";
import type { DraftStatus, ModelSourceResponse } from "@/lib/models/draft";
import { edgePath, layeredLayout } from "./graph";
import { AlertIcon, ChevronDownIcon } from "./icons";
import { Badge, Button, CopyButton, Spinner } from "./ui";

/**
 * The map: a one-line strip at the top of the column, read once to orient,
 * that opens the focused C4 view as an overlay over the column. It never
 * pushes the flow down.
 */

const ROW_GAP = 56;
const MIN_NODE_W = 190;
const MAX_NODE_W = 280;
/** Files named in a box before the rest fold into "+N more". */
const MAX_FILES = 4;
const COL_GAP = 18;
const PAD = 14;

/**
 * A box's height before it's measured: name, the description wrapped, and
 * one line per file named. The real height replaces it after the first paint.
 */
function estimateHeight(n: MapNode, w: number) {
  const inner = w - 24;
  const descLines = n.description
    ? Math.ceil((n.description.length * 6.4) / inner)
    : 0;
  const nameLines = Math.ceil(
    (n.name.length * 7.6 +
      (n.state === "added" || n.state === "removed" ? 60 : 0)) /
      inner,
  );
  const files = Math.min(n.files.length, MAX_FILES + 1);
  const foot = n.state === "touched" || n.state === "added" ? 24 : 0;
  return (
    16 + nameLines * 18 + descLines * 16 + (files ? 8 + files * 18 : 0) + foot
  );
}

function layout(
  nodes: MapNode[],
  edges: MapEdge[],
  width: number,
  heights: Map<string, number> = new Map(),
) {
  return layeredLayout(
    nodes,
    edges,
    width,
    (n, w) => heights.get(n.id) ?? estimateHeight(n, w),
    {
      minW: MIN_NODE_W,
      maxW: MAX_NODE_W,
      rowGap: ROW_GAP,
      colGap: COL_GAP,
      pad: PAD,
    },
  );
}

function Squares({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const green = total ? Math.round((5 * add) / total) : 0;
  const red = total ? Math.min(5 - green, Math.round((5 * del) / total)) : 0;
  return (
    <span className="map-squares">
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < green ? "g" : i < green + red ? "r" : ""} />
      ))}
    </span>
  );
}

/** Scroll the diff to a file and flash its header. */
export function jumpToFile(path: string): boolean {
  const section = document.getElementById(`file-${encodeURIComponent(path)}`);
  if (!section) return false;
  section.scrollIntoView({ block: "start" });
  section.classList.remove("flash");
  void section.offsetWidth;
  section.classList.add("flash");
  return true;
}

const fileName = (path: string) => path.split("/").pop() ?? path;

function MapCanvas({
  map,
  width,
  onHover,
  onJump,
}: {
  map: MapResponse;
  width: number;
  onHover: (component: string | null) => void;
  onJump: (path: string) => void;
}) {
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const { placed, height } = useMemo(
    () => layout(map.nodes, map.edges, width, heights),
    [map, width, heights],
  );
  const boxes = useRef(new Map<string, HTMLDivElement>());

  // Boxes size to what they say; lay out again once their real heights are
  // known, so arrows meet their edges.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    let changed = false;
    for (const [id, el] of boxes.current) {
      const h = el.offsetHeight;
      next.set(id, h);
      if (Math.abs((heights.get(id) ?? -1) - h) > 1) changed = true;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lays out again from measured heights, before paint
    if (changed) setHeights(next);
  }, [placed, heights]);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  // Spread several arrows along a node's edge rather than stacking them.
  const ends = useMemo(() => {
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    const sorted = [...map.edges].sort(
      (a, b) =>
        (placed.get(a.destination)?.x ?? 0) -
        (placed.get(b.destination)?.x ?? 0),
    );
    for (const e of sorted) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.key]);
      inn.set(e.destination, [...(inn.get(e.destination) ?? []), e.key]);
    }
    return { out, inn };
  }, [map.edges, placed]);

  return (
    <div className="map-canvas" style={{ height }}>
      <svg
        className="map-edges"
        width={width}
        height={height}
        aria-hidden="false"
      >
        <defs>
          {[
            ["quiet", "var(--fg-subtle)"],
            ["add", "var(--success)"],
            ["del", "var(--danger)"],
            ["chg", "var(--attention)"],
          ].map(([k, fill]) => (
            <marker
              key={k}
              id={`map-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 1 9 5 0 9z" style={{ fill }} />
            </marker>
          ))}
        </defs>
        {map.edges.map((e) => {
          const a = placed.get(e.source);
          const b = placed.get(e.destination);
          if (!a || !b || a === b) return null;
          const outs = ends.out.get(e.source) ?? [];
          const ins = ends.inn.get(e.destination) ?? [];
          const { d } = edgePath(
            a,
            b,
            outs.indexOf(e.key),
            outs.length,
            ins.indexOf(e.key),
            ins.length,
          );
          const kind =
            e.state === "added"
              ? "add"
              : e.state === "removed"
                ? "del"
                : e.state === "changed"
                  ? "chg"
                  : "quiet";
          return (
            <g
              key={e.key}
              onMouseEnter={() => setHoverEdge(e.key)}
              onMouseLeave={() => setHoverEdge(null)}
            >
              <path d={d} className="map-hit" />
              <path
                d={d}
                className={`map-edge ${e.state} ${hoverEdge === e.key ? "hover" : ""}`}
                markerEnd={`url(#map-${kind})`}
              />
              <title>{`${a.name} → ${b.name}: ${e.description}${e.before ? ` (was: ${e.before})` : ""}`}</title>
            </g>
          );
        })}
      </svg>

      {map.edges.map((e) => {
        const a = placed.get(e.source);
        const b = placed.get(e.destination);
        if (!a || !b || a === b) return null;
        if (e.state === "same" && hoverEdge !== e.key) return null;
        const outs = ends.out.get(e.source) ?? [];
        const ins = ends.inn.get(e.destination) ?? [];
        const { lx, ly } = edgePath(
          a,
          b,
          outs.indexOf(e.key),
          outs.length,
          ins.indexOf(e.key),
          ins.length,
        );
        return (
          <div
            key={e.key}
            className={`map-label ${e.state}`}
            style={{ left: lx, top: ly }}
          >
            {e.state === "changed" ? (
              <>
                <s>{e.before}</s> <span>{e.description}</span>
              </>
            ) : (
              e.description
            )}
          </div>
        );
      })}

      {[...placed.values()].map((n) => {
        // "+1 more" takes a line anyway: name the file instead.
        const shown = n.fileStats.slice(
          0,
          n.fileStats.length === MAX_FILES + 1 ? MAX_FILES + 1 : MAX_FILES,
        );
        const more = n.fileStats.length - shown.length;
        return (
          <div
            key={n.id}
            ref={(el) => {
              if (el) boxes.current.set(n.id, el);
              else boxes.current.delete(n.id);
            }}
            className={`map-node ${n.state} ${n.files.length ? "jumps" : ""}`}
            style={{ left: n.x, top: n.y, width: n.w }}
            onMouseEnter={() =>
              onHover(n.state === "neighbour" ? null : n.name)
            }
            onMouseLeave={() => onHover(null)}
            onClick={() => n.files[0] && onJump(n.files[0])}
          >
            <h4>
              <span>{n.name}</span>
              {n.state === "added" && <span className="map-tag new">New</span>}
              {n.state === "removed" && (
                <span className="map-tag removed">Removed</span>
              )}
            </h4>
            {n.description && <p>{n.description}</p>}
            {shown.length > 0 && (
              <ul className="map-files">
                {shown.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      title={`${f.path} — show it in the diff`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onJump(f.path);
                      }}
                    >
                      <span className="name">{fileName(f.path)}</span>
                      {f.status === "A" && <span className="new">new</span>}
                      {f.status === "D" && (
                        <span className="gone">deleted</span>
                      )}
                      <span className="stat">
                        <span className="text-[var(--success)]">
                          +{f.additions}
                        </span>
                        {f.deletions > 0 && (
                          <span className="text-[var(--danger)]">
                            {" "}
                            −{f.deletions}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
                {more > 0 && (
                  <li>
                    <button
                      type="button"
                      className="more"
                      onClick={(e) => {
                        e.stopPropagation();
                        onJump(n.fileStats[shown.length].path);
                      }}
                    >
                      +{more} more {more === 1 ? "file" : "files"}
                    </button>
                  </li>
                )}
              </ul>
            )}
            {(n.state === "touched" || n.state === "added") && (
              <div className="foot">
                <span className="mono">
                  <span className="text-[var(--success)]">+{n.additions}</span>
                  {n.deletions > 0 && (
                    <span className="text-[var(--danger)]">
                      {" "}
                      −{n.deletions}
                    </span>
                  )}
                </span>
                <Squares add={n.additions} del={n.deletions} />
                <span>
                  {n.files.length} {n.files.length === 1 ? "file" : "files"}
                  {n.newFiles > 0 &&
                    n.newFiles < n.files.length &&
                    `, ${n.newFiles} new`}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A thumbnail of the focused map: boxes only, coloured by what happened. */
function Thumb({ map }: { map: MapResponse }) {
  const W = 112;
  const H = 56;
  const { placed, height } = useMemo(
    () => layout(map.nodes, map.edges, 600),
    [map],
  );
  const scale = Math.min(W / 600, H / height);
  const ox = (W - 600 * scale) / 2;
  const oy = (H - height * scale) / 2;
  return (
    <svg
      className="map-thumb"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
    >
      {map.edges
        .filter((e) => e.state !== "same")
        .map((e) => {
          const a = placed.get(e.source);
          const b = placed.get(e.destination);
          if (!a || !b) return null;
          return (
            <line
              key={e.key}
              x1={ox + (a.x + a.w / 2) * scale}
              y1={oy + (a.y + a.h) * scale}
              x2={ox + (b.x + b.w / 2) * scale}
              y2={oy + b.y * scale}
              strokeWidth="1.2"
              style={{
                stroke:
                  e.state === "removed"
                    ? "var(--danger)"
                    : e.state === "changed"
                      ? "var(--attention)"
                      : "var(--success)",
              }}
            />
          );
        })}
      {[...placed.values()].map((n) => (
        <rect
          key={n.id}
          x={ox + n.x * scale}
          y={oy + n.y * scale}
          width={n.w * scale}
          height={n.h * scale}
          rx="3"
          strokeWidth="1.2"
          strokeDasharray={n.state === "removed" ? "2 2" : undefined}
          style={{
            fill:
              n.state === "added"
                ? "var(--diff-add-num-bg)"
                : n.state === "removed"
                  ? "var(--diff-del-bg)"
                  : n.state === "neighbour"
                    ? "var(--canvas-subtle)"
                    : "var(--canvas)",
            stroke:
              n.state === "added"
                ? "var(--success)"
                : n.state === "removed"
                  ? "var(--danger)"
                  : n.state === "neighbour"
                    ? "var(--border)"
                    : "var(--fg-muted)",
          }}
        />
      ))}
    </svg>
  );
}

const names = (list: MapNode[]) => {
  const n = list.map((x) => x.name);
  return n.length <= 3
    ? n.join(", ")
    : `${n.slice(0, 3).join(", ")} +${n.length - 3}`;
};

function summary(map: MapResponse) {
  const changed = map.nodes.filter((n) => n.state !== "neighbour");
  const added = map.nodes.filter((n) => n.state === "added");
  const removed = map.nodes.filter((n) => n.state === "removed");
  const arrows = {
    added: map.edges.filter((e) => e.state === "added").length,
    removed: map.edges.filter((e) => e.state === "removed").length,
    changed: map.edges.filter((e) => e.state === "changed").length,
  };
  const structural =
    added.length +
      removed.length +
      arrows.added +
      arrows.removed +
      arrows.changed >
    0;
  const parts: React.ReactNode[] = [];
  if (!structural) {
    parts.push(
      <>
        <b>{changed.length}</b> touched
      </>,
      names(changed),
      map.local ? (
        "local model, no structural diff"
      ) : map.baseModel ? (
        "no structural change"
      ) : map.baseError ? (
        <span className="text-[var(--attention)]" title={map.baseError}>
          couldn&apos;t read the base model, so nothing shows as new or removed
        </span>
      ) : (
        "no model at base"
      ),
    );
    return parts;
  }
  parts.push(
    <>
      <b>{changed.length}</b> changed
    </>,
  );
  if (added.length)
    parts.push(
      <span className="text-[var(--success)]">
        {names(added)} {added.length === 1 ? "is" : "are"} new
      </span>,
    );
  if (removed.length)
    parts.push(
      <span className="text-[var(--danger)]">{names(removed)} removed</span>,
    );
  const plural = (n: number, w: string) =>
    `${n} ${w} ${n === 1 ? "arrow" : "arrows"}`;
  if (arrows.added)
    parts.push(
      <span className="text-[var(--success)]">
        {plural(arrows.added, "new")}
      </span>,
    );
  if (arrows.changed)
    parts.push(
      <span className="text-[var(--attention)]">
        {plural(arrows.changed, "relabelled")}
      </span>,
    );
  if (arrows.removed)
    parts.push(
      <span className="text-[var(--danger)]">
        {plural(arrows.removed, "removed")}
      </span>,
    );
  return parts;
}

function Ticked({ text }: { text: string }) {
  return (
    <span>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <code key={i} className="mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}

const CLAUDE_CODE_INSTALL = "https://code.claude.com/docs/en/setup";

type Finished = Extract<DraftStatus, { status: "done" }>;
type ModelAnswer = ModelSourceResponse | { error: string };
type JobState = DraftStatus["status"];

/** Polls while a draft runs rather than adding a watch event: drafts are rare. */
function useModelDraft(repo: string, wanted: boolean, onDrafted: () => void) {
  const [answer, setAnswer] = useState<{
    repo: string;
    source: ModelSourceResponse;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Shown once, after a draft this window watched finish */
  const [finished, setFinished] = useState<{
    repo: string;
    job: Finished;
  } | null>(null);
  const last = useRef<{ repo: string; status: JobState } | null>(null);
  const onDraftedRef = useRef(onDrafted);
  useEffect(() => {
    onDraftedRef.current = onDrafted;
  }, [onDrafted]);

  const request = useCallback(
    async (method: "GET" | "POST", redraft = false) => {
      const params = new URLSearchParams({ repo });
      if (redraft) params.set("redraft", "1");
      try {
        const response = await fetch(`/api/model?${params}`, {
          method,
          cache: "no-store",
        });
        const data = (await response.json()) as ModelAnswer;
        if (!response.ok || "error" in data) {
          setError("error" in data ? data.error : response.statusText);
          return;
        }
        setError(null);
        const status = data.job.status;
        const before = last.current?.repo === repo ? last.current.status : null;
        // Read the map again on any done this window hasn't seen, not only
        // after a running one: a draft can finish before the first poll.
        if (status === "done" && before !== "done") {
          if (before === "running")
            setFinished({ repo, job: data.job as Finished });
          onDraftedRef.current();
        }
        last.current = { repo, status };
        setAnswer({ repo, source: data });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [repo],
  );

  useEffect(() => {
    if (!wanted || !repo) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches when its key changes
    void request("GET");
  }, [wanted, repo, request]);

  const source = answer?.repo === repo ? answer.source : null;
  const running = source?.job.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  const start = useCallback(
    (redraft = false) => {
      setFinished(null);
      void request("POST", redraft);
    },
    [request],
  );
  return {
    source,
    error,
    finished: finished?.repo === repo ? finished.job : null,
    start,
  };
}

type DraftApi = ReturnType<typeof useModelDraft>;

const formatSeconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatSeconds(now - since)}</>;
}

const filesLeft = (n: number) =>
  `${n} ${n === 1 ? "file" : "files"} no component covers`;

function DraftProgress({ draft }: { draft: DraftApi }) {
  const job = draft.source?.job;
  if (draft.error)
    return (
      <span className="flex items-center gap-1 text-[12px] text-[var(--attention)]">
        <AlertIcon size={11} /> {draft.error}
      </span>
    );
  if (job?.status === "running")
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-[var(--fg-muted)]">
        <Spinner className="!h-3 !w-3" />
        {job.phase} · <Elapsed since={job.startedAt} />
      </span>
    );
  if (job?.status === "failed")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--attention)]">
        <AlertIcon size={11} />
        <span className="truncate" title={job.error}>
          The draft failed: {job.error}
        </span>
        <Button size="sm" onClick={() => draft.start(true)}>
          Try again
        </Button>
      </span>
    );
  if (job?.status === "unavailable")
    return (
      <span className="text-[12px] text-[var(--attention)]">
        Drafting a model needs{" "}
        <a
          className="text-[var(--accent)]"
          href={CLAUDE_CODE_INSTALL}
          target="_blank"
          rel="noreferrer"
        >
          Claude Code
        </a>
        : Backstory couldn&apos;t find <code className="mono">claude</code> on
        its PATH.
      </span>
    );
  if (draft.finished)
    return (
      <span className="text-[12px] text-[var(--fg-muted)]">
        Drafted in {formatSeconds(draft.finished.durationMs)}
        {draft.finished.unmatched > 0 &&
          ` · ${filesLeft(draft.finished.unmatched)}`}
        {draft.finished.ambiguous > 0 &&
          ` · ${draft.finished.ambiguous} in more than one`}
      </span>
    );
  return null;
}

function DraftOffer({ draft }: { draft: DraftApi }) {
  const job = draft.source?.job;
  const idle = !job || job.status === "idle" || job.status === "unavailable";
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[var(--fg-muted)]">
          · no model in this repo
        </span>
        {idle && (
          <Button size="sm" variant="primary" onClick={() => draft.start()}>
            Draft a model
          </Button>
        )}
        <DraftProgress draft={draft} />
      </div>
      {idle && (
        <span className="text-[11px] text-[var(--fg-subtle)]">
          Claude reads the code at HEAD, read-only, and drafts a C4 model kept
          on this machine, never in the repo. It takes a few minutes and uses
          your Claude Code account.
        </span>
      )}
    </div>
  );
}

function LocalModel({ map, draft }: { map: MapResponse; draft: DraftApi }) {
  if (!map.modelFile) return null;
  const running = draft.source?.job.status === "running";
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
      {map.drafted && (
        <Badge tone="draft" className="!py-0 !leading-4">
          Draft
        </Badge>
      )}
      <code className="mono min-w-0 truncate" title={map.modelFile}>
        {map.modelFile}
      </code>
      <CopyButton
        value={map.modelFile}
        variant="invisible"
        title="Copy the model file's path, to correct it"
        label="Copy path"
      />
      {!running && (
        <Button
          size="sm"
          variant="invisible"
          onClick={() => {
            if (
              window.confirm(
                "Redraft the model? Claude reads the code at HEAD again, which takes a few minutes on your Claude Code account. The current file is kept as workspace.dsl.bak.",
              )
            )
              draft.start(true);
          }}
        >
          Redraft
        </Button>
      )}
      <DraftProgress draft={draft} />
    </div>
  );
}

export function MapStrip({
  map,
  repo,
  onHover,
  onOpenFile,
  onModelChange,
}: {
  map: MapResponse | null;
  repo: string;
  onHover: (component: string | null) => void;
  /** Bring a file into view; the page knows whether there's a diff to show it in */
  onOpenFile: (path: string) => void;
  /** A draft was written: read the map again */
  onModelChange: () => void;
}) {
  const draft = useModelDraft(
    repo,
    Boolean(map && (map.local || (map.status === "none" && !map.error))),
    onModelChange,
  );
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(320, entry.contentRect.width - 22)),
    );
    observer.observe(el);
    return () => observer.disconnect();
    // Again once the map arrives: before it does, the strip isn't rendered.
  }, [map]);

  if (!map) return null;
  if (map.status === "none" || map.nodes.length === 0) {
    const offer =
      map.status === "none" && !map.error && draft.source?.source === "none";
    return (
      <div className="map-strip quiet flex-wrap">
        <span className="text-[13px] font-semibold">Map</span>
        {map.error ? (
          <span className="flex items-center gap-1 text-[12px] text-[var(--attention)]">
            <AlertIcon size={11} /> Couldn&apos;t read the model:{" "}
            <Ticked text={map.error} />
          </span>
        ) : offer ? (
          <DraftOffer draft={draft} />
        ) : (
          <span className="text-[12px] text-[var(--fg-muted)]">
            {map.status === "none"
              ? "· no architecture/workspace.dsl in this repo, and no local model"
              : "· this change touches no mapped component"}
          </span>
        )}
        {map.local && <LocalModel map={map} draft={draft} />}
      </div>
    );
  }

  const parts = summary(map);
  return (
    <div ref={boxRef} className="map-strip">
      <Thumb map={map} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">Map</div>
        <div className="truncate text-[12px] text-[var(--fg-muted)]">
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {p}
            </span>
          ))}
        </div>
        {(map.unmapped.length > 0 || map.ambiguous.length > 0) && (
          <div
            className="text-[11px] text-[var(--fg-subtle)]"
            title={[
              ...map.unmapped,
              ...map.ambiguous.map((a) => `${a.file} ← ${a.ids.join(", ")}`),
            ].join("\n")}
          >
            {map.unmapped.length > 0 &&
              (map.local
                ? `${map.unmapped.length} ${map.unmapped.length === 1 ? "file" : "files"} the local model has no place for`
                : `${map.unmapped.length} unmapped`)}
            {map.unmapped.length > 0 && map.ambiguous.length > 0 && " · "}
            {map.ambiguous.length > 0 && `${map.ambiguous.length} ambiguous`}
          </div>
        )}
        {map.local && <LocalModel map={map} draft={draft} />}
      </div>
      <button
        type="button"
        className="map-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide map" : "Show map"}
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>

      {open && (
        <div className="map-overlay">
          <div className="map-card">
            <MapCanvas
              map={map}
              width={width}
              onHover={onHover}
              onJump={(path) => {
                setOpen(false);
                onHover(null);
                onOpenFile(path);
              }}
            />
            <div className="map-foot">
              {map.hidden > 0 && (
                <span className="map-chip">
                  <b>+{map.hidden}</b> unchanged{" "}
                  {map.hidden === 1 ? "component" : "components"}
                </span>
              )}
              <span className="flex-1" />
              <span>Unchanged arrows label on hover</span>
            </div>
          </div>
          <div className="map-key">
            <span>
              <i className="box touched" />
              Touched
            </span>
            <span>
              <i className="box added" />
              New
            </span>
            <span>
              <i className="box removed" />
              Removed
            </span>
            <span>
              <i className="box neighbour" />
              Unchanged
            </span>
            <span>
              <span className="text-[var(--success)]">—</span> new arrow
            </span>
            <span>
              <span className="text-[var(--attention)]">—</span> relabelled
            </span>
            <span>
              <span className="text-[var(--danger)]">- -</span> removed arrow
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
