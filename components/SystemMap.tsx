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
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { edgePath, layeredLayout } from "./graph";
import { AlertIcon, ChevronDownIcon } from "./icons";
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
  nodes,
  edges,
  width,
  highlight,
  onJump,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  /** A component's name, outlined as hovering it would */
  highlight: string | null;
  onJump: (path: string) => void;
}) {
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const { placed, height } = useMemo(
    () => layout(nodes, edges, width, heights),
    [nodes, edges, width, heights],
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
        "hand-written map, so nothing shows as new or removed"
      ) : map.baseModel ? (
        "no structural change"
      ) : map.baseError ? (
        <span className="text-[var(--attention)]" title={map.baseError}>
          couldn&apos;t read the base&apos;s map, so nothing shows as new or
          removed
        </span>
      ) : (
        "no map at the base to compare with"
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

/**
 * Turns reading the repo's maps and data models as it opens on or off.
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
function useMapDraft(
  repo: string,
  rev: string,
  given: MapResponse | null,
  onRead: () => void,
) {
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
  const latest = useRef({ view: `${repo}\n${rev}`, given });
  useEffect(() => {
    latest.current = { view: `${repo}\n${rev}`, given };
  }, [repo, rev, given]);
  // Try again repeats the last read: a Redraft only when that was a Redraft,
  // since one reads main in full and removes every derived map.
  const lastRedraft = useRef(false);

  const request = useCallback(
    async (method: "GET" | "POST", redraft = false) => {
      if (method === "POST") lastRedraft.current = redraft;
      const view = `${repo}\n${rev}`;
      const params = new URLSearchParams({ repo, rev });
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
    [repo, rev],
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
  // stays that way, while the branch view, whose rev stays "branch" as HEAD
  // moves, reads again once its new head needs it.
  const autoStart =
    !map?.error &&
    (map?.status === "none" || (map?.source === "drafted" && !map.baseModel)) &&
    map.draft?.status === "idle" &&
    map.draft.auto;
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    const view = `${repo}\n${rev}`;
    if (!autoStart) {
      autoStarted.current = null;
      return;
    }
    if (autoStarted.current === view) return;
    autoStarted.current = view;
    void request("POST");
  }, [autoStart, repo, rev, request]);

  const setAuto = useCallback(
    async (on: boolean) => {
      try {
        await setAutoReading(repo, on);
        onReadRef.current();
      } catch (err) {
        setError({
          over: given,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [repo, given],
  );

  return {
    map,
    error: error?.over === given ? error.message : null,
    start: (redraft = false) => void request("POST", redraft),
    retry: () => void request("POST", lastRedraft.current),
    turnOn: () => void setAuto(true),
    turnOff: () => void setAuto(false),
  };
}

type DraftApi = ReturnType<typeof useMapDraft>;

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

function DraftProgress({ draft }: { draft: DraftApi }) {
  const job = draft.map?.draft;
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
          The read failed: {job.error}
        </span>
        <Button size="sm" onClick={draft.retry}>
          Try again
        </Button>
      </span>
    );
  if (job?.status === "unavailable")
    return (
      <span className="text-[12px] text-[var(--attention)]">
        <ClaudeCodeNotice reason={job.reason} needs="Drawing the map needs" />
      </span>
    );
  return null;
}

/** What a view with no map of its own shows, where the map goes: the read's progress, or the offer to read it. */
function DraftOffer({ draft }: { draft: DraftApi }) {
  const job = draft.map?.draft;
  const idle =
    !job ||
    job.status === "idle" ||
    job.status === "unavailable" ||
    job.status === "done";
  const provider = job?.status === "idle" ? job.provider : null;
  const offerAuto = job?.status === "idle" && !job.auto;
  const file = draft.map?.handFile;
  const mainMap = draft.map?.mainMap;
  return (
    <div className="story-card">
      <h3>
        {mainMap
          ? "This change isn't on the map yet"
          : "Backstory hasn't drawn this repo yet"}
      </h3>
      {mainMap ? (
        <p>
          Backstory has main&apos;s map. {provider ?? "The AI provider"} reads
          only what the diff changes, read-only, and adds it. The map stays on
          this machine.
        </p>
      ) : (
        <p>
          Backstory draws a map of your system from the code.{" "}
          {provider ?? "The AI provider"} reads main once, read-only, then only
          what each diff changes. The map stays on this machine.
        </p>
      )}
      {idle && (
        <span className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => draft.start()}>
            Draw the map
          </Button>
          {offerAuto && (
            <Button onClick={draft.turnOn}>Read automatically</Button>
          )}
        </span>
      )}
      <span className="mt-2 flex justify-center">
        <DraftProgress draft={draft} />
      </span>
      {provider && (
        <span className="est">
          {provider} ·{" "}
          {mainMap
            ? "seconds for this change"
            : "a few minutes for main, then seconds a change"}{" "}
          · uses your {provider} login
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
              title="Copy the path a hand-written map goes at, to write one"
              label="Copy path"
            />
          </span>
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

/** A drafted map's footnote: who drew it, whether reads start by themselves, Turn off or Read automatically, and Draw again. */
function DraftFootnote({ map, draft }: { map: MapResponse; draft: DraftApi }) {
  const running = map.draft?.status === "running";
  // Name who reads again from a read that's idle or unavailable, the provider
  // set now: a running or done read's status doesn't say which one ran it.
  const provider =
    map.draft?.status === "idle" || map.draft?.status === "unavailable"
      ? map.draft.provider
      : (map.drawnBy ?? null);
  const parts: React.ReactNode[] = [];
  if (map.auto)
    parts.push(
      "Read automatically",
      <button
        type="button"
        className="text-[var(--accent)] hover:underline"
        onClick={draft.turnOff}
      >
        Turn off
      </button>,
    );
  else
    parts.push(
      <button
        type="button"
        className="text-[var(--accent)] hover:underline"
        onClick={draft.turnOn}
      >
        Read automatically
      </button>,
    );
  return (
    <span className="part inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="draft" className="!py-0 !leading-4">
        Drawn by {map.drawnBy ?? "the AI provider"}
      </Badge>
      <span className="text-[11px] text-[var(--fg-subtle)]">
        {parts.map((part, i) => (
          <span key={i}>
            {i > 0 && " · "}
            {part}
          </span>
        ))}
      </span>
      {/* Offers Draw the map when the head has a map but its base doesn't,
          so reading the base isn't left to Draw again, which reads main in full. */}
      {!map.baseModel && map.draft?.status === "idle" && !map.auto && (
        <Button size="sm" variant="invisible" onClick={() => draft.start()}>
          Draw the map
        </Button>
      )}
      {!running && (
        <Button
          size="sm"
          variant="invisible"
          onClick={() => {
            if (
              window.confirm(
                `Draw the map again? ${provider ?? "The AI provider"} reads main again in full and this view is worked out from it, which can take a few minutes on your account. Other views are worked out again as you open them. The current map is kept if it fails.`,
              )
            )
              draft.start(true);
          }}
        >
          Draw again
        </Button>
      )}
      <DraftProgress draft={draft} />
    </span>
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
  map: given,
  repo,
  rev,
  highlight = null,
  onOpenFile,
  onModelChange,
  children,
}: {
  map: MapResponse | null;
  repo: string;
  rev: string;
  /** A component to outline, asked for from Files changed */
  highlight?: { name: string; at: number } | null;
  /** Show a file in Files changed */
  onOpenFile: (path: string) => void;
  /** A drafted map was read: read the map again */
  onModelChange: () => void;
  /** The rest of the line under the map: the data model's summary */
  children?: React.ReactNode;
}) {
  const draft = useMapDraft(repo, rev, given, onModelChange);
  const map = draft.map;
  const drafted = map?.source === "drafted";
  // Keep a click's Show map or Hide map only for the view it was made on.
  const view = `${repo}\n${rev}`;
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
          <DraftOffer draft={draft} />
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
            {drafted && <DraftFootnote map={map} draft={draft} />}
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
                  onJump={onOpenFile}
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

  const work = mostWork(map);
  const parts = [...(work ? [work] : []), ...summary(map)];
  return (
    <section ref={boxRef} className="story-map">
      <div className="map-card">
        {width > 0 && (
          <MapCanvas
            nodes={map.nodes}
            edges={map.edges}
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
                ? `${map.unmapped.length} ${map.unmapped.length === 1 ? "file" : "files"} the hand-written map has no place for`
                : `${map.unmapped.length} unmapped`)}
            {map.unmapped.length > 0 && map.ambiguous.length > 0 && " · "}
            {map.ambiguous.length > 0 && `${map.ambiguous.length} ambiguous`}
          </span>
        )}
        {children}
        {drafted && <DraftFootnote map={map} draft={draft} />}
        {map.local && <LocalModel map={map} />}
      </div>
    </section>
  );
}
