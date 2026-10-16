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
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { edgePath, layeredLayout } from "./graph";
import { AlertIcon } from "./icons";
import { Badge, Button, CopyButton, Spinner } from "./ui";

/**
 * The map: the focused C4 view, open at the top of the story at the column's
 * width, with one line under it saying what it shows.
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
  highlight,
  onJump,
}: {
  map: MapResponse;
  width: number;
  /** A component's name, outlined as hovering it would */
  highlight: string | null;
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
            className={`map-node ${n.state} ${n.files.length ? "jumps" : ""} ${highlight === n.name ? "highlight" : ""}`}
            style={{ left: n.x, top: n.y, width: n.w }}
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
                      title={`${f.path}: show it in Files changed`}
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
        <ClaudeCodeNotice reason={job.reason} needs="Drafting a model needs" />
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
  const file = draft.source?.file;
  return (
    <div className="story-card">
      <h3>This repo has no map yet</h3>
      <p>
        Backstory draws the map from a C4 model of the system. Claude Code reads
        the code at HEAD, read-only, and drafts one that stays on this machine,
        never in the repo.
      </p>
      {idle && (
        <Button variant="primary" onClick={() => draft.start()}>
          Draft a model
        </Button>
      )}
      <span className="mt-2 flex justify-center">
        <DraftProgress draft={draft} />
      </span>
      {idle && (
        <span className="est">
          Claude Code · a few minutes · uses your Claude Code account
        </span>
      )}
      {file && (
        <span className="est flex min-w-0 items-center justify-center gap-1.5">
          <span className="shrink-0">Or write one by hand at</span>
          <code className="mono min-w-0 truncate" title={file}>
            {file}
          </code>
          <span className="shrink-0">
            <CopyButton
              value={file}
              variant="invisible"
              title="Copy the path a local model goes at, to write one by hand"
              label="Copy path"
            />
          </span>
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

/** The component with the most changed lines, as the line under the map names it. */
function mostWork(map: MapResponse): React.ReactNode {
  const busiest = map.nodes
    .filter((n) => n.files.length > 0)
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))[0];
  if (!busiest) return null;
  const files = busiest.files.length;
  return (
    <>
      <b>{busiest.name}</b> does most of the work: {files}{" "}
      {files === 1 ? "file" : "files"}
      {busiest.newFiles > 0 && `, ${busiest.newFiles} new`}
    </>
  );
}

export function SystemMap({
  map,
  repo,
  highlight = null,
  onOpenFile,
  onModelChange,
  children,
}: {
  map: MapResponse | null;
  repo: string;
  /** A component to outline, asked for from Files changed */
  highlight?: { name: string; at: number } | null;
  /** Show a file in Files changed */
  onOpenFile: (path: string) => void;
  /** A draft was written: read the map again */
  onModelChange: () => void;
  /** The rest of the line under the map: the data model's summary */
  children?: React.ReactNode;
}) {
  const draft = useModelDraft(
    repo,
    Boolean(map && (map.local || (map.status === "none" && !map.error))),
    onModelChange,
  );
  const boxRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
    // Again once the map arrives: before it does, the section isn't rendered.
  }, [map]);

  useEffect(() => {
    if (highlight)
      boxRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [highlight]);

  if (!map)
    return children ? <div className="story-line">{children}</div> : null;
  if (map.status === "none" || map.nodes.length === 0) {
    const offer =
      map.status === "none" && !map.error && draft.source?.source === "none";
    return (
      <>
        {offer ? (
          <DraftOffer draft={draft} />
        ) : (
          <div className="story-line">
            {map.error ? (
              <span className="flex items-center gap-1 text-[var(--attention)]">
                <AlertIcon size={11} /> Couldn&apos;t read the model:{" "}
                <Ticked text={map.error} />
              </span>
            ) : (
              <span>
                {map.status === "none"
                  ? "No architecture/workspace.dsl in this repo, and no local model"
                  : "This change touches no mapped component"}
              </span>
            )}
          </div>
        )}
        {map.local && (
          <div className="story-line">
            <LocalModel map={map} draft={draft} />
          </div>
        )}
        {children && <div className="story-line">{children}</div>}
      </>
    );
  }

  const work = mostWork(map);
  const parts = [...(work ? [work] : []), ...summary(map)];
  return (
    <section ref={boxRef} className="story-map">
      <div className="map-card">
        {width > 0 && (
          <MapCanvas
            map={map}
            width={width - 2}
            highlight={highlight?.name ?? null}
            onJump={onOpenFile}
          />
        )}
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
      <div className="story-line">
        {parts.map((p, i) => (
          <span key={i} className="part">
            {p}
          </span>
        ))}
        {(map.unmapped.length > 0 || map.ambiguous.length > 0) && (
          <span
            className="part"
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
          </span>
        )}
        {children}
        {map.local && <LocalModel map={map} draft={draft} />}
      </div>
    </section>
  );
}
