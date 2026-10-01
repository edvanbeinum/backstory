"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { MapEdge, MapNode, MapResponse } from "@/lib/map";
import { AlertIcon, ChevronDownIcon } from "./icons";

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

interface Placed extends MapNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A fixed layered layout: each element's row is the longest chain of arrows
 * leading to it, so callers sit above what they call. Within a row, nodes
 * follow their callers' order.
 */
/**
 * A box's height before it's measured: name, the description wrapped, and
 * one line per file named. The real height replaces it after the first paint.
 */
function estimateHeight(n: MapNode, w: number) {
  const inner = w - 24;
  const descLines = n.description ? Math.ceil((n.description.length * 6.4) / inner) : 0;
  const nameLines = Math.ceil((n.name.length * 7.6 + (n.state === "added" || n.state === "removed" ? 60 : 0)) / inner);
  const files = Math.min(n.files.length, MAX_FILES + 1);
  const foot = n.state === "touched" || n.state === "added" ? 24 : 0;
  return 16 + nameLines * 18 + descLines * 16 + (files ? 8 + files * 18 : 0) + foot;
}

function layout(
  nodes: MapNode[],
  edges: MapEdge[],
  width: number,
  heights: Map<string, number> = new Map(),
) {
  const ids = nodes.map((n) => n.id);
  const into = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) if (e.source !== e.destination) into.get(e.destination)?.push(e.source);

  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0; // a cycle: break it here
    visiting.add(id);
    const r = Math.max(-1, ...(into.get(id) ?? []).map(rankOf)) + 1;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of ids) rankOf(id);

  const rows: MapNode[][] = [];
  for (const n of nodes) (rows[rank.get(n.id)!] ??= []).push(n);
  const packed = rows.filter(Boolean);

  const placed = new Map<string, Placed>();
  let y = PAD;
  for (const row of packed) {
    // Order by where the callers sit, so arrows cross less.
    const pos = (n: MapNode) => {
      const xs = (into.get(n.id) ?? []).map((s) => placed.get(s)).filter(Boolean) as Placed[];
      return xs.length ? xs.reduce((a, p) => a + p.x + p.w / 2, 0) / xs.length : Infinity;
    };
    row.sort((a, b) => pos(a) - pos(b));
    const perLine = Math.max(1, Math.min(row.length, Math.floor((width - 2 * PAD + COL_GAP) / (MIN_NODE_W + COL_GAP))));
    for (let start = 0; start < row.length; start += perLine) {
      const line = row.slice(start, start + perLine);
      const w = Math.min(MAX_NODE_W, (width - 2 * PAD - (line.length - 1) * COL_GAP) / line.length);
      const total = line.length * w + (line.length - 1) * COL_GAP;
      let x = (width - total) / 2;
      const hs = line.map((n) => heights.get(n.id) ?? estimateHeight(n, w));
      line.forEach((n, i) => {
        placed.set(n.id, { ...n, x, y, w, h: hs[i] });
        x += w + COL_GAP;
      });
      y += Math.max(...hs) + ROW_GAP;
    }
  }
  return { placed, height: y - ROW_GAP + PAD };
}

function edgePath(a: Placed, b: Placed, ai: number, an: number, bi: number, bn: number) {
  const ax = a.x + (a.w * (ai + 1)) / (an + 1);
  const bx = b.x + (b.w * (bi + 1)) / (bn + 1);
  if (b.y > a.y + a.h / 2) {
    const y1 = a.y + a.h;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return { d: `M${ax} ${y1} C${ax} ${mid} ${bx} ${mid} ${bx} ${y2 - 1}`, lx: (ax + bx) / 2, ly: mid };
  }
  if (b.y + b.h < a.y + a.h / 2) {
    const y1 = a.y;
    const y2 = b.y + b.h;
    const mid = (y1 + y2) / 2;
    return { d: `M${ax} ${y1} C${ax} ${mid} ${bx} ${mid} ${bx} ${y2 + 1}`, lx: (ax + bx) / 2, ly: mid };
  }
  // Same row: loop underneath.
  const y1 = a.y + a.h;
  const y2 = b.y + b.h;
  const dip = Math.max(y1, y2) + 28;
  return { d: `M${ax} ${y1} C${ax} ${dip} ${bx} ${dip} ${bx} ${y2 + 1}`, lx: (ax + bx) / 2, ly: dip - 6 };
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
function jumpToFile(path: string) {
  const section = document.getElementById(`file-${encodeURIComponent(path)}`);
  if (!section) return;
  section.scrollIntoView({ block: "start" });
  section.classList.remove("flash");
  void section.offsetWidth;
  section.classList.add("flash");
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
    if (changed) setHeights(next);
  }, [placed, heights]);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  // Spread several arrows along a node's edge rather than stacking them.
  const ends = useMemo(() => {
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    const sorted = [...map.edges].sort(
      (a, b) => (placed.get(a.destination)?.x ?? 0) - (placed.get(b.destination)?.x ?? 0),
    );
    for (const e of sorted) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.key]);
      inn.set(e.destination, [...(inn.get(e.destination) ?? []), e.key]);
    }
    return { out, inn };
  }, [map.edges, placed]);

  return (
    <div className="map-canvas" style={{ height }}>
      <svg className="map-edges" width={width} height={height} aria-hidden="false">
        <defs>
          {[
            ["quiet", "var(--fg-subtle)"],
            ["add", "var(--success)"],
            ["del", "var(--danger)"],
            ["chg", "var(--attention)"],
          ].map(([k, fill]) => (
            <marker key={k} id={`map-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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
          const { d } = edgePath(a, b, outs.indexOf(e.key), outs.length, ins.indexOf(e.key), ins.length);
          const kind = e.state === "added" ? "add" : e.state === "removed" ? "del" : e.state === "changed" ? "chg" : "quiet";
          return (
            <g key={e.key} onMouseEnter={() => setHoverEdge(e.key)} onMouseLeave={() => setHoverEdge(null)}>
              <path d={d} className="map-hit" />
              <path d={d} className={`map-edge ${e.state} ${hoverEdge === e.key ? "hover" : ""}`} markerEnd={`url(#map-${kind})`} />
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
        const { lx, ly } = edgePath(a, b, outs.indexOf(e.key), outs.length, ins.indexOf(e.key), ins.length);
        return (
          <div key={e.key} className={`map-label ${e.state}`} style={{ left: lx, top: ly }}>
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
        const shown = n.fileStats.slice(0, n.fileStats.length === MAX_FILES + 1 ? MAX_FILES + 1 : MAX_FILES);
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
            onMouseEnter={() => onHover(n.state === "neighbour" ? null : n.name)}
            onMouseLeave={() => onHover(null)}
            onClick={() => n.files[0] && onJump(n.files[0])}
          >
            <h4>
              <span>{n.name}</span>
              {n.state === "added" && <span className="map-tag new">New</span>}
              {n.state === "removed" && <span className="map-tag removed">Removed</span>}
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
                      {f.status === "D" && <span className="gone">deleted</span>}
                      <span className="stat">
                        <span className="text-[var(--success)]">+{f.additions}</span>
                        {f.deletions > 0 && <span className="text-[var(--danger)]"> −{f.deletions}</span>}
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
                  {n.deletions > 0 && <span className="text-[var(--danger)]"> −{n.deletions}</span>}
                </span>
                <Squares add={n.additions} del={n.deletions} />
                <span>
                  {n.files.length} {n.files.length === 1 ? "file" : "files"}
                  {n.newFiles > 0 && n.newFiles < n.files.length && `, ${n.newFiles} new`}
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
  const { placed, height } = useMemo(() => layout(map.nodes, map.edges, 600), [map]);
  const scale = Math.min(W / 600, H / height);
  const ox = (W - 600 * scale) / 2;
  const oy = (H - height * scale) / 2;
  return (
    <svg className="map-thumb" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
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
              style={{ stroke: e.state === "removed" ? "var(--danger)" : e.state === "changed" ? "var(--attention)" : "var(--success)" }}
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
            fill: n.state === "added" ? "var(--diff-add-num-bg)" : n.state === "removed" ? "var(--diff-del-bg)" : n.state === "neighbour" ? "var(--canvas-subtle)" : "var(--canvas)",
            stroke: n.state === "added" ? "var(--success)" : n.state === "removed" ? "var(--danger)" : n.state === "neighbour" ? "var(--border)" : "var(--fg-muted)",
          }}
        />
      ))}
    </svg>
  );
}

const names = (list: MapNode[]) => {
  const n = list.map((x) => x.name);
  return n.length <= 3 ? n.join(", ") : `${n.slice(0, 3).join(", ")} +${n.length - 3}`;
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
  const structural = added.length + removed.length + arrows.added + arrows.removed + arrows.changed > 0;
  const parts: React.ReactNode[] = [];
  if (!structural) {
    parts.push(
      <>
        <b>{changed.length}</b> touched
      </>,
      names(changed),
      map.local
        ? "local model, no structural diff"
        : map.baseModel
          ? "no structural change"
          : "no model at base",
    );
    return parts;
  }
  parts.push(
    <>
      <b>{changed.length}</b> changed
    </>,
  );
  if (added.length) parts.push(<span className="text-[var(--success)]">{names(added)} {added.length === 1 ? "is" : "are"} new</span>);
  if (removed.length) parts.push(<span className="text-[var(--danger)]">{names(removed)} removed</span>);
  const plural = (n: number, w: string) => `${n} ${w} ${n === 1 ? "arrow" : "arrows"}`;
  if (arrows.added) parts.push(<span className="text-[var(--success)]">{plural(arrows.added, "new")}</span>);
  if (arrows.changed) parts.push(<span className="text-[var(--attention)]">{plural(arrows.changed, "relabelled")}</span>);
  if (arrows.removed) parts.push(<span className="text-[var(--danger)]">{plural(arrows.removed, "removed")}</span>);
  return parts;
}

export function MapStrip({
  map,
  onHover,
}: {
  map: MapResponse | null;
  onHover: (component: string | null) => void;
}) {
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
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width - 22)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!map) return null;
  if (map.status === "none" || map.nodes.length === 0) {
    return (
      <div className="map-strip quiet">
        <span className="text-[13px] font-semibold">Map</span>
        <span className="text-[12px] text-[var(--fg-muted)]">
          {map.status === "none"
            ? "· no architecture/workspace.json in this repo, and no local model"
            : "· this change touches no mapped component"}
        </span>
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
        {map.stale && (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--attention)]">
            <AlertIcon size={11} /> Model JSON is stale: the DSL changed without a re-export, so this
            map may be out of date.
          </div>
        )}
        {(map.unmapped.length > 0 || map.ambiguous.length > 0) && (
          <div
            className="text-[11px] text-[var(--fg-subtle)]"
            title={[...map.unmapped, ...map.ambiguous.map((a) => `${a.file} ← ${a.ids.join(", ")}`)].join("\n")}
          >
            {map.unmapped.length > 0 &&
              (map.local
                ? `${map.unmapped.length} ${map.unmapped.length === 1 ? "file" : "files"} the local model has no place for`
                : `${map.unmapped.length} unmapped`)}
            {map.unmapped.length > 0 && map.ambiguous.length > 0 && " · "}
            {map.ambiguous.length > 0 && `${map.ambiguous.length} ambiguous`}
          </div>
        )}
      </div>
      <button type="button" className="map-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
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
                // After the overlay is gone, so the jump lands where you can see it.
                requestAnimationFrame(() => jumpToFile(path));
              }}
            />
            <div className="map-foot">
              {map.hidden > 0 && (
                <span className="map-chip">
                  <b>+{map.hidden}</b> unchanged {map.hidden === 1 ? "component" : "components"}
                </span>
              )}
              <span className="flex-1" />
              <span>Unchanged arrows label on hover</span>
            </div>
          </div>
          <div className="map-key">
            <span><i className="box touched" />Touched</span>
            <span><i className="box added" />New</span>
            <span><i className="box removed" />Removed</span>
            <span><i className="box neighbour" />Unchanged</span>
            <span><span className="text-[var(--success)]">—</span> new arrow</span>
            <span><span className="text-[var(--attention)]">—</span> relabelled</span>
            <span><span className="text-[var(--danger)]">- -</span> removed arrow</span>
          </div>
        </div>
      )}
    </div>
  );
}
