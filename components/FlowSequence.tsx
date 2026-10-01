"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";

import { shortLabels, type FlowMode, type FlowRow, type LaneGroup } from "@/lib/flows/rows";
import type { FlowParticipant } from "@/lib/flows/types";
import { STEP_CODE_H } from "./StepCode";

/** Row height, and where in the row the arrow runs. Matches the mockup. */
const ROW = 40;
const ARROW_Y = 30;
const GUTTER = 76;
const MIN_LANE = 84;
/** Below this, lane names alternate between two rows so they can be wider. */
const STAGGER_BELOW = 150;
/** The component bands above the lane names. */
const BAND_H = 24;
const NONE_OPEN = new Set<string>();

/**
 * The sequence diagram: participants across the top, one call per row,
 * drawn as custom SVG on a row grid. No library: the rows are the diff's
 * rows, and a layout engine would only fight that.
 */
export function FlowSequence({
  rows,
  lanes,
  groups,
  mode,
  activeKeys,
  onRowClick,
  footer,
  open = NONE_OPEN,
  renderCode,
}: {
  rows: FlowRow[];
  lanes: FlowParticipant[];
  /** Lanes by component, in lane order */
  groups: LaneGroup[];
  mode: FlowMode;
  activeKeys: Set<string>;
  onRowClick: (row: FlowRow) => void;
  footer: React.ReactNode;
  /** Rows whose code is open beneath them */
  open?: Set<string>;
  renderCode?: (row: FlowRow) => React.ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const measure = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = measure.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const labels = useMemo(() => shortLabels(lanes), [lanes]);
  const bandName = (g: LaneGroup) =>
    g.component ?? (g.external ? "Framework" : "Not on the map");

  // Lanes share the width; a component group gets at least the room its
  // name needs, so the name is never cut. Wider than the column scrolls.
  const laneW = Math.max(MIN_LANE, (width - GUTTER) / Math.max(lanes.length, 1));
  const spans: { g: LaneGroup; left: number; width: number }[] = [];
  const centre = new Map<string, number>();
  const laneWidth = new Map<string, number>();
  let cursor = 0;
  for (const g of groups) {
    const n = g.end - g.start + 1;
    const w = Math.max(n * laneW, bandName(g).length * 6.6 + 28);
    spans.push({ g, left: cursor, width: w });
    for (let k = 0; k < n; k++) {
      const lane = lanes[g.start + k];
      centre.set(lane.name, cursor + (w * (k + 0.5)) / n);
      laneWidth.set(lane.name, w / n);
    }
    cursor += w;
  }
  const area = Math.max(cursor, laneW * lanes.length);
  const inner = GUTTER + area;
  const narrowest = Math.min(...[...laneWidth.values(), laneW]);
  const stagger = lanes.length > 1 && narrowest < STAGGER_BELOW;
  const x = (name: string) => centre.get(name) ?? laneW / 2;
  const chipWidth = (name: string) => (stagger ? 2 : 1) * (laneWidth.get(name) ?? laneW) - 12;
  // An open row's code sits under it at a fixed height, so every row below
  // moves down by the same amount and the arrows keep to their rows.
  const tops: number[] = [];
  let y = 0;
  for (const row of rows) {
    tops.push(y);
    y += ROW + (open.has(row.key) ? STEP_CODE_H : 0);
  }
  const height = y;

  const marker = (kind: string) => `url(#${id}-${kind})`;
  // A name chip is centred on its lane, but kept inside the lanes' area.
  const chipLeft = (p: FlowParticipant) => {
    const half = Math.min(chipWidth(p.name), (labels.get(p.name) ?? p.label).length * 7 + 18) / 2;
    return Math.min(Math.max(x(p.name), half), area - half);
  };

  return (
    <div className="flow-seq">
      <div ref={measure} className="thin-scroll overflow-x-auto">
        <div style={{ minWidth: inner }}>
          <div className="flow-grid flow-head">
            <span className="oh">{mode === "after" ? "now" : "was"}</span>
            <span className="oh">{mode === "diff" ? "now" : ""}</span>
            <span />
            <div className="flow-lanes" style={{ height: (stagger ? 58 : 36) + BAND_H }}>
              {spans.map(({ g, left, width: w }) => (
                <span
                  key={g.start}
                  className={`flow-band ${g.component ? "" : "plain"}`}
                  style={{ left: left + 3, width: w - 6 }}
                  title={
                    g.component
                      ? `${g.component}: a component on the map`
                      : g.external
                        ? "Framework and library types"
                        : "Code the map doesn't place"
                  }
                >
                  <span>{bandName(g)}</span>
                </span>
              ))}
              {lanes.map((p, i) => (
                <span
                  key={p.name}
                  className={`flow-who ${p.external ? "external" : ""}`}
                  style={{
                    left: chipLeft(p),
                    top: BAND_H + (stagger && i % 2 === 1 ? 31 : 6),
                    maxWidth: chipWidth(p.name),
                  }}
                  title={[p.name, p.component && `in ${p.component}`, p.external && "external"]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {labels.get(p.name) ?? p.label}
                </span>
              ))}
            </div>
          </div>

          <div className="flow-rows">
            <svg
              className="flow-svg"
              width={area}
              height={height}
              aria-hidden="true"
            >
              <defs>
                {[
                  ["ctx", "var(--fg)"],
                  ["add", "var(--success)"],
                  ["on", "var(--accent)"],
                  ["quiet", "var(--fg-subtle)"],
                ].map(([kind, fill]) => (
                  <marker
                    key={kind}
                    id={`${id}-${kind}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 1 9 5 0 9z" style={{ fill }} />
                  </marker>
                ))}
                <marker
                  id={`${id}-del`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M1 1 9 5 1 9" fill="none" strokeWidth="1.5" style={{ stroke: "var(--danger)" }} />
                </marker>
              </defs>
              {lanes.map((p) => (
                <line key={p.name} className="lifeline" x1={x(p.name)} x2={x(p.name)} y1={0} y2={height} />
              ))}
              {/* Where one component ends and the next begins: a call that
                  crosses this line is one component calling another. */}
              {spans.slice(1).map(({ g, left }) => (
                <line key={g.start} className="boundary" x1={left} x2={left} y1={0} y2={height} />
              ))}
              {rows.map((row, i) => {
                const from = x(row.step.from);
                const to = x(row.step.to);
                const top = tops[i];
                const d =
                  from === to
                    ? `M${from} ${top + 22} h20 v12 h-18`
                    : `M${from} ${top + ARROW_Y} H${to + (to > from ? -2 : 2)}`;
                const active = activeKeys.has(row.key);
                const kind = row.step.verified ? `k-${row.kind}` : "unverified";
                return (
                  <path
                    key={row.key}
                    d={d}
                    className={`${kind} ${active ? "inview" : ""}`}
                    markerEnd={marker(
                      active ? "on" : !row.step.verified ? "quiet" : row.kind,
                    )}
                  />
                );
              })}
            </svg>

            {rows.map((row) => {
              const from = x(row.step.from);
              const to = x(row.step.to);
              // The rows' lane cell starts where the SVG does, so they share x.
              // A label that won't fit to the right of its arrow ends at the
              // card's edge instead, reading back over the lanes to its left.
              const start = from === to ? from + 28 : Math.min(from, to) + 8;
              const text = [row.step.label, row.step.returns ? `→ ${row.step.returns}` : ""].join(" ");
              const fits = start + text.length * 7.3 + 8 <= area;
              const place = fits
                ? { left: start, maxWidth: `calc(100% - ${start + 8}px)` }
                : { right: 8, maxWidth: area - 16 };
              const first = mode === "after" ? row.now : row.was;
              const second = mode === "diff" ? row.now : null;
              return (
                <Fragment key={row.key}>
                <div
                  role="button"
                  tabIndex={-1}
                  className={`flow-grid flow-row k-${row.kind} ${activeKeys.has(row.key) ? "inview" : ""}`}
                  onClick={() => onRowClick(row)}
                  title={`${row.step.caller} · ${row.step.file}:${row.step.line}`}
                >
                  <span className="n">{first ?? ""}</span>
                  <span className="n">{second ?? ""}</span>
                  <span className="m" />
                  <span className="l">
                    <span className="lab" style={place}>
                      <span className="call min-w-0 truncate">{row.step.label}</span>
                      {row.step.returns && (
                        <span className="ret min-w-0 shrink-[2] truncate">→ {row.step.returns}</span>
                      )}
                      {row.step.repeat && <span className="flow-badge">× {row.step.repeat}</span>}
                      {row.again && <span className="flow-badge">{row.again}</span>}
                      {!row.step.verified && (
                        <span
                          className="flow-badge warn"
                          title={`"${row.step.symbol}" isn't on ${row.step.file}:${row.step.line}`}
                        >
                          unverified
                        </span>
                      )}
                    </span>
                  </span>
                </div>
                {open.has(row.key) && (
                  // Pinned to the visible part of a card that scrolls sideways.
                  <div className="step-code-slot" style={{ width: width || undefined }}>
                    {renderCode?.(row)}
                  </div>
                )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flow-foot">{footer}</div>
    </div>
  );
}
