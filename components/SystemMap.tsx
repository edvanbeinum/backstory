"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RecordUse } from "@/lib/flows/rows";
import type { MapEdge, MapNode, MapResponse } from "@/lib/map";
import { viewKey, viewParams } from "@/lib/url";
import { edgePath, nestedLayout } from "./graph";
import { AlertIcon, ChevronDownIcon } from "./icons";
import { Button, CopyButton, Spinner, Ticked } from "./ui";
import { useView } from "./ViewContext";

/**
 * The map: the focused C4 view, open at the top of the story at the column's
 * width, with one line under it saying what it shows.
 */

const ROW_GAP = 56;
const MIN_NODE_W = 190;
const MAX_NODE_W = 280;
/** Files named in a box before the rest fold into "+N more". */
const MAX_FILES = 4;
/** Records named in a box before the rest fold into "+N more". */
const MAX_RECORDS = 4;
const COL_GAP = 18;
const PAD = 14;
/** A container's or system's box: the header above its children, and the space around them. */
const GROUP_HEADER = 32;
const GROUP_INSET = 12;

const GROUP_TYPE: Record<string, string> = {
  softwareSystem: "Software system",
  container: "Container",
};

/**
 * A box's height before it's measured: name, the description wrapped, one
 * line per file named, and a line of records. The real height replaces it
 * after the first paint.
 */
function estimateHeight(n: MapNode, w: number, records: boolean) {
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
  return (
    16 +
    nameLines * 18 +
    descLines * 16 +
    (files ? 8 + files * 18 : 0) +
    (records ? 26 : 0)
  );
}

function layout(
  nodes: MapNode[],
  edges: MapEdge[],
  width: number,
  heights: Map<string, number>,
  records: Map<string, RecordUse[]>,
) {
  return nestedLayout(
    nodes,
    edges,
    width,
    (n, w) =>
      heights.get(n.id) ??
      estimateHeight(n, w, (records.get(n.name)?.length ?? 0) > 0),
    {
      minW: MIN_NODE_W,
      maxW: MAX_NODE_W,
      rowGap: ROW_GAP,
      colGap: COL_GAP,
      pad: PAD,
    },
    { header: GROUP_HEADER, inset: GROUP_INSET },
  );
}

/** Scroll the diff to a file and flash its header. */
export function jumpToFile(path: string, root: ParentNode = document): boolean {
  const section = root.querySelector<HTMLElement>(
    `#${CSS.escape(`file-${encodeURIComponent(path)}`)}`,
  );
  if (!section) return false;
  section.scrollIntoView({ block: "start" });
  section.classList.remove("flash");
  void section.offsetWidth;
  section.classList.add("flash");
  return true;
}

const fileName = (path: string) => path.split("/").pop() ?? path;

const NO_RECORDS = new Map<string, RecordUse[]>();

/**
 * Splits a box's list into the items it names and the ones folded into
 * "+N more". Names one past `max` too, since "+1 more" takes a line anyway.
 */
function fold<T>(list: T[], max: number): [T[], T[]] {
  const at = list.length === max + 1 ? max + 1 : max;
  return [list.slice(0, at), list.slice(at)];
}

function recordTitle(r: RecordUse) {
  const parts = r.declared ? ["Declared here"] : [];
  if (r.steps.length > 0)
    parts.push(
      `${r.steps.length === 1 ? "Step" : "Steps"} ${r.steps.join(", ")}: ${r.does.join(", ")}`,
    );
  return `${r.entity}\n${parts.join(" · ")}`;
}

function MapCanvas({
  nodes,
  edges,
  width,
  highlight,
  records = NO_RECORDS,
  onJump,
  onShowRecord,
  onHoverNode,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  /** A component's name, outlined as hovering it would */
  highlight: string | null;
  /** The records each component uses, by its name */
  records?: Map<string, RecordUse[]>;
  onJump: (path: string) => void;
  /** A record was clicked, to show it in the data model */
  onShowRecord?: (entity: string) => void;
  /** The pointer moved onto a box, by its component's name, or off it */
  onHoverNode?: (name: string | null) => void;
}) {
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const { placed, height } = useMemo(
    () => layout(nodes, edges, width, heights, records),
    [nodes, edges, width, heights, records],
  );
  const [hoverRecord, setHoverRecord] = useState<string | null>(null);
  const usesHovered = (name: string) =>
    hoverRecord !== null &&
    (records.get(name) ?? []).some((r) => r.entity === hoverRecord);
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
    const sorted = [...edges].sort(
      (a, b) =>
        (placed.get(a.destination)?.x ?? 0) -
        (placed.get(b.destination)?.x ?? 0),
    );
    for (const e of sorted) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.key]);
      inn.set(e.destination, [...(inn.get(e.destination) ?? []), e.key]);
    }
    return { out, inn };
  }, [edges, placed]);
  const around = { boxes: [...placed.values()], clearance: COL_GAP / 2 };

  return (
    <div className="map-canvas" style={{ height }}>
      {[...placed.values()]
        .filter((n) => n.group)
        .map((n) => {
          const additions = n.fileStats.reduce((t, f) => t + f.additions, 0);
          const deletions = n.fileStats.reduce((t, f) => t + f.deletions, 0);
          return (
            <div
              key={n.id}
              className={`map-group ${n.state} ${highlight === n.name ? "highlight" : ""}`}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
              title={n.description || undefined}
            >
              <h4 style={{ height: GROUP_HEADER }}>
                <span className="name">{n.name}</span>
                <span className="type">{GROUP_TYPE[n.type] ?? n.type}</span>
                {n.state === "added" && (
                  <span className="map-tag new">New</span>
                )}
                {n.state === "removed" && (
                  <span className="map-tag removed">Removed</span>
                )}
                {n.files.length > 0 && (
                  <button
                    type="button"
                    className="files mono"
                    title={`${n.files.join("\n")}\nShow them in Files changed`}
                    onClick={() => onJump(n.files[0])}
                  >
                    {n.files.length} {n.files.length === 1 ? "file" : "files"}{" "}
                    <span className="text-[var(--success)]">+{additions}</span>
                    {deletions > 0 && (
                      <span className="text-[var(--danger)]">
                        {" "}
                        −{deletions}
                      </span>
                    )}
                  </button>
                )}
              </h4>
            </div>
          );
        })}
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
        {edges.map((e) => {
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
            around,
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

      {edges.map((e) => {
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
          around,
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
        if (n.group) return null;
        const [shown, folded] = fold(n.fileStats, MAX_FILES);
        const more = folded.length;
        const [usesShown, usesMore] = fold(
          records.get(n.name) ?? [],
          MAX_RECORDS,
        );
        return (
          <div
            key={n.id}
            ref={(el) => {
              if (el) boxes.current.set(n.id, el);
              else boxes.current.delete(n.id);
            }}
            className={`map-node ${n.state} ${n.files.length ? "jumps" : ""} ${highlight === n.name ? "highlight" : ""} ${usesHovered(n.name) ? "uses" : ""}`}
            style={{ left: n.x, top: n.y, width: n.w }}
            onMouseEnter={onHoverNode && (() => onHoverNode(n.name))}
            onMouseLeave={onHoverNode && (() => onHoverNode(null))}
            onClick={() => {
              if (n.files[0]) onJump(n.files[0]);
            }}
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
            {usesShown.length > 0 && (
              <ul className="map-records">
                {usesShown.map((r) => {
                  const cls = `map-record mono ${hoverRecord === r.entity ? "uses" : ""}`;
                  const hover = {
                    onMouseEnter: () => setHoverRecord(r.entity),
                    onMouseLeave: () => setHoverRecord(null),
                  };
                  return (
                    <li key={r.entity}>
                      {onShowRecord ? (
                        <button
                          type="button"
                          className={cls}
                          title={`${recordTitle(r)}\nShow it in the data model`}
                          {...hover}
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowRecord(r.entity);
                          }}
                        >
                          {r.entity}
                        </button>
                      ) : (
                        <span className={cls} title={recordTitle(r)} {...hover}>
                          {r.entity}
                        </span>
                      )}
                    </li>
                  );
                })}
                {usesMore.length > 0 && (
                  <li>
                    <span
                      className="map-record more"
                      title={usesMore.map(recordTitle).join("\n\n")}
                    >
                      +{usesMore.length} more
                    </span>
                  </li>
                )}
              </ul>
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

/** What the map's colours say changed in its boxes, or why it can't say: nothing when every box is the same. */
function summary(map: MapResponse) {
  const added = map.nodes.filter((n) => n.state === "added");
  const removed = map.nodes.filter((n) => n.state === "removed");
  const parts: React.ReactNode[] = [];
  if (map.baseError)
    parts.push(
      <span className="text-[var(--attention)]" title={map.baseError}>
        couldn&apos;t read the base&apos;s map, so nothing shows as new or
        removed
      </span>,
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
  return parts;
}

/**
 * Turns reading the repo's maps, data models and change descriptions as it
 * opens on or off.
 * Turning it on starts main's two reads before the page reads the view again,
 * so the view's own reads wait behind them instead of reading their bases in
 * full.
 */
export async function setAutoReading(repo: string, on: boolean) {
  const params = new URLSearchParams({ repo, auto: on ? "1" : "0" });
  const response = await fetch(`/api/data?${params}`, { method: "POST" });
  if (!response.ok) throw new Error(`Backstory answered ${response.status}.`);
  if (!on) return;
  const trunk = `repo=${encodeURIComponent(repo)}&trunk=1`;
  await Promise.all([
    fetch(`/api/data?${trunk}`, { method: "POST" }),
    fetch(`/api/map?${trunk}`, { method: "POST" }),
  ]);
}

/**
 * The view's map, replaced by what a read request answered until the page
 * reads it again. Polls while a read runs rather than adding a watch event:
 * reads are rare.
 */
export function useMapDraft(
  repo: string,
  rev: string,
  given: MapResponse | null,
  onRead: () => void,
) {
  const { ref } = useView();
  const viewId = viewKey({ repo, ref, rev });
  const [answer, setAnswer] = useState<{
    over: MapResponse | null;
    map: MapResponse;
  } | null>(null);
  const [error, setError] = useState<{
    over: MapResponse | null;
    message: string;
  } | null>(null);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);
  // Tags an answer with the page's latest read of the view when it arrives,
  // not the read it was sent over: a page read that lands while a read starts
  // says idle, and would hide the answer that says running, so nothing would
  // poll. A page read that lands after the answer still replaces it.
  const latest = useRef({ view: viewId, given });
  useEffect(() => {
    latest.current = { view: viewId, given };
  }, [viewId, given]);
  // Try again repeats the last read: a Redraft only when that was a Redraft,
  // since one reads main in full and removes every derived map.
  const lastRedraft = useRef(false);

  const request = useCallback(
    async (method: "GET" | "POST", redraft = false) => {
      if (method === "POST") lastRedraft.current = redraft;
      const view = viewId;
      const params = viewParams({ repo, ref, rev });
      if (redraft) params.set("redraft", "1");
      // Drops the answer for a view the page has left.
      const over = () =>
        latest.current.view === view ? latest.current.given : undefined;
      try {
        const response = await fetch(`/api/map?${params}`, {
          method,
          cache: "no-store",
        });
        // A map has `error` too, the model file's: only a failed response
        // is a failed request.
        const body = (await response.json()) as
          MapResponse | { error?: string };
        if (!response.ok || !("nodes" in body)) {
          const at = over();
          if (at !== undefined)
            setError({ over: at, message: body.error ?? response.statusText });
          return;
        }
        const at = over();
        if (at === undefined) return;
        setError(null);
        setAnswer({ over: at, map: body });
        // The page reads the map again once a read ends, so the flows and
        // the data model see the drafted map too.
        if (body.draft?.status !== "running") onReadRef.current();
      } catch (err) {
        const at = over();
        if (at !== undefined)
          setError({
            over: at,
            message: err instanceof Error ? err.message : String(err),
          });
      }
    },
    [viewId, repo, ref, rev],
  );

  const map = answer?.over === given ? answer.map : given;
  const running = map?.draft?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  // With reading turned on, a view with no map yet, or with a drafted head
  // but no base to compare it with, starts its read on open. It starts once
  // until the view's read status changes: a read that fails or can't run
  // stays that way, while the branch view and uncommitted work, whose revs
  // stay the same as HEAD moves, read again once their new head needs it.
  const autoStart =
    !map?.error &&
    (map?.status === "none" || (map?.source === "drafted" && !map.baseModel)) &&
    map.draft?.status === "idle" &&
    map.draft.auto;
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStart) {
      autoStarted.current = null;
      return;
    }
    if (autoStarted.current === viewId) return;
    autoStarted.current = viewId;
    void request("POST");
  }, [autoStart, viewId, request]);

  return {
    map,
    error: error?.over === given ? error.message : null,
    start: (redraft = false) => void request("POST", redraft),
    retry: () => void request("POST", lastRedraft.current),
  };
}

export type MapDraftApi = ReturnType<typeof useMapDraft>;

/** Whether the repo is turned off and the read hasn't started, so the page offers the one click that starts it. */
const offered = (map: MapResponse) =>
  map.draft?.status === "idle" ? !map.draft.auto : map.draft?.status === "done";

/** The map's read in the space the map will take, so a read that takes minutes doesn't look frozen. */
function DraftPending({ map }: { map: MapResponse | null }) {
  const first = map?.mainRead?.status === "running" ? map.mainRead : null;
  return (
    <div className="story-card map-pending" role="status">
      <Spinner className="!h-6 !w-6" />
      <p className="font-semibold text-[var(--fg)]">Drawing the map</p>
      {first && <p>Once this is drawn, future reads will be much quicker.</p>}
      {first?.big && (
        <p className="text-[var(--fg-subtle)]">
          This is a big repo, so it takes a while. You can leave this open.
        </p>
      )}
    </div>
  );
}

/**
 * Where the map goes before there is one: with the repo turned off, the
 * button that draws it and the repo's switch, since the footnote that also
 * has the switch only shows once something was drawn; otherwise the read
 * that is drawing it.
 */
function DraftOffer({
  draft,
  onSetAuto,
}: {
  draft: MapDraftApi;
  onSetAuto?: (on: boolean) => Promise<void>;
}) {
  const [switchError, setSwitchError] = useState<string | null>(null);
  if (!draft.map || !offered(draft.map))
    return <DraftPending map={draft.map} />;
  return (
    <div className="story-card">
      <h3>The map hasn&apos;t been drawn yet</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => draft.start()}>
          Draw the map
        </Button>
        {onSetAuto && (
          <Button
            onClick={() =>
              onSetAuto(true).then(
                () => setSwitchError(null),
                (err: unknown) =>
                  setSwitchError(
                    err instanceof Error ? err.message : String(err),
                  ),
              )
            }
          >
            Read this repo automatically
          </Button>
        )}
      </div>
      {switchError && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-[var(--attention)]">
          <AlertIcon size={11} /> Couldn&apos;t change it:{" "}
          <Ticked text={switchError} />
        </p>
      )}
    </div>
  );
}

/** Draws a drafted head's base, with the repo turned off, so reading it isn't left to Draw the map again, which reads main in full. */
function DrawBase({ map, draft }: { map: MapResponse; draft: MapDraftApi }) {
  if (
    map.source !== "drafted" ||
    map.baseModel ||
    map.draft?.status !== "idle" ||
    map.draft.auto
  )
    return null;
  return (
    <span className="part">
      <Button size="sm" variant="invisible" onClick={() => draft.start()}>
        Draw the map
      </Button>
    </span>
  );
}

const NODE_KEY = [
  ["touched", "Touched"],
  ["added", "New"],
  ["removed", "Removed"],
  ["neighbour", "Unchanged"],
] as const;

const EDGE_KEY = [
  ["added", "text-[var(--success)]", "—", "new arrow"],
  ["changed", "text-[var(--attention)]", "—", "relabelled"],
  ["removed", "text-[var(--danger)]", "- -", "removed arrow"],
] as const;

/** Names only the states this map draws, and records when a box lists any. */
function MapKey({ map, records }: { map: MapResponse; records: boolean }) {
  // Skip unchanged groups, whose boundary is drawn plain rather than as an
  // Unchanged box.
  const nodes = new Set<string>(
    map.nodes
      .filter((n) => !n.group || n.state !== "neighbour")
      .map((n) => n.state),
  );
  const edges = new Set<string>(map.edges.map((e) => e.state));
  return (
    <div className="map-key">
      {NODE_KEY.filter(([state]) => nodes.has(state)).map(([state, word]) => (
        <span key={`node ${state}`}>
          <i className={`box ${state}`} />
          {word}
        </span>
      ))}
      {EDGE_KEY.filter(([state]) => edges.has(state)).map(
        ([state, tone, mark, word]) => (
          <span key={`edge ${state}`}>
            <span className={tone}>{mark}</span> {word}
          </span>
        ),
      )}
      {records && (
        <span>
          <i className="record" />
          record it uses
        </span>
      )}
    </div>
  );
}

/** A hand-written map's path, to correct it. */
function LocalModel({ map }: { map: MapResponse }) {
  if (!map.modelFile) return null;
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
      <code className="mono min-w-0 truncate" title={map.modelFile}>
        {map.modelFile}
      </code>
      <CopyButton
        value={map.modelFile}
        variant="invisible"
        title="Copy the hand-written map's path, to correct it"
        label="Copy path"
      />
    </div>
  );
}

export function SystemMap({
  draft,
  repo,
  rev,
  highlight = null,
  records = NO_RECORDS,
  onOpenFile,
  onShowRecord,
  onHoverNode,
  onSetAuto,
  children,
}: {
  /** The view's map and its read, from `useMapDraft` */
  draft: MapDraftApi;
  /** The repo's switch for reading as it opens, from `useDescription` */
  onSetAuto?: (on: boolean) => Promise<void>;
  repo: string;
  rev: string;
  /** A component to outline, asked for from Files changed */
  highlight?: { name: string; at: number } | null;
  /** The records each component uses, by its name, from `recordsOnComponents` */
  records?: Map<string, RecordUse[]>;
  /** A record was clicked, to show it in the data model */
  onShowRecord?: (entity: string) => void;
  /** The pointer moved onto a box, by its component's name, or off it */
  onHoverNode?: (name: string | null) => void;
  /** Show a file in Files changed */
  onOpenFile: (path: string) => void;
  /** The rest of the line under the map: the data model's summary */
  children?: React.ReactNode;
}) {
  const map = draft.map;
  // Keep a click's Show map or Hide map only for the view it was made on.
  const { ref } = useView();
  const view = viewKey({ repo, ref, rev });
  const [toggled, setToggled] = useState<{ view: string; open: boolean }>();
  const showWhole = toggled?.view === view && toggled.open;
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
    // Again once the map arrives or the whole map opens: before then, the
    // section isn't rendered.
  }, [map, showWhole]);

  useEffect(() => {
    if (highlight)
      boxRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [highlight]);

  if (!map)
    return children ? <div className="story-line">{children}</div> : null;
  if (map.status === "none" || map.nodes.length === 0) {
    const offer = map.status === "none" && !map.error && map.draft;
    return (
      <>
        {offer ? (
          <DraftOffer draft={draft} onSetAuto={onSetAuto} />
        ) : (
          <div className="story-line">
            {map.error ? (
              <span className="flex items-center gap-1 text-[var(--attention)]">
                <AlertIcon size={11} /> Couldn&apos;t read the map:{" "}
                <Ticked text={map.error} />
              </span>
            ) : (
              <span>
                {map.status === "none"
                  ? "This repo has no map"
                  : "This change touches no mapped component"}
              </span>
            )}
            {map.whole && (
              <button
                type="button"
                className="story-disclose"
                aria-expanded={showWhole}
                onClick={() => setToggled({ view, open: !showWhole })}
              >
                {showWhole ? "Hide map" : "Show map"}
                <ChevronDownIcon
                  size={12}
                  className={showWhole ? "rotate-180" : ""}
                />
              </button>
            )}
            <DrawBase map={map} draft={draft} />
          </div>
        )}
        {showWhole && map.whole && (
          <section ref={boxRef} className="story-map">
            <div className="map-card">
              {width > 0 && (
                <MapCanvas
                  nodes={map.whole.nodes}
                  edges={map.whole.edges}
                  width={width - 2}
                  highlight={highlight?.name ?? null}
                  records={records}
                  onJump={onOpenFile}
                  onShowRecord={onShowRecord}
                  onHoverNode={onHoverNode}
                />
              )}
            </div>
          </section>
        )}
        {map.local && (
          <div className="story-line">
            <LocalModel map={map} />
          </div>
        )}
        {children && <div className="story-line">{children}</div>}
      </>
    );
  }

  const parts = summary(map);
  return (
    <section ref={boxRef} className="story-map">
      <div className="map-card">
        {width > 0 && (
          <MapCanvas
            nodes={map.nodes}
            edges={map.edges}
            width={width - 2}
            highlight={highlight?.name ?? null}
            records={records}
            onJump={onOpenFile}
            onShowRecord={onShowRecord}
            onHoverNode={onHoverNode}
          />
        )}
      </div>
      <MapKey
        map={map}
        records={map.nodes.some(
          (n) => !n.group && (records.get(n.name)?.length ?? 0) > 0,
        )}
      />
      <div className="story-line">
        {parts.map((p, i) => (
          <span key={i} className="part">
            {p}
          </span>
        ))}
        {children}
        <DrawBase map={map} draft={draft} />
        {map.local && <LocalModel map={map} />}
      </div>
    </section>
  );
}
