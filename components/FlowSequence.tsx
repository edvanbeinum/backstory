"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { shortLabels, type FlowMode, type FlowRow } from "@/lib/flows/rows";
import type { FlowParticipant } from "@/lib/flows/types";

/** Row height, and where in the row the arrow runs. Matches the mockup. */
const ROW = 40;
const ARROW_Y = 30;
const GUTTER = 76;
const MIN_LANE = 120;

/**
 * The sequence diagram: participants across the top, one call per row,
 * drawn as custom SVG on a row grid. No library: the rows are the diff's
 * rows, and a layout engine would only fight that.
 */
export function FlowSequence({
  rows,
  lanes,
  mode,
  activeKeys,
  onRowClick,
  footer,
}: {
  rows: FlowRow[];
  lanes: FlowParticipant[];
  mode: FlowMode;
  activeKeys: Set<string>;
  onRowClick: (row: FlowRow) => void;
  footer: React.ReactNode;
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
  const laneW = Math.max(MIN_LANE, (width - GUTTER) / Math.max(lanes.length, 1));
  const inner = GUTTER + laneW * lanes.length;
  const x = (name: string) => {
    const i = lanes.findIndex((l) => l.name === name);
    return laneW * ((i === -1 ? 0 : i) + 0.5);
  };
  const height = rows.length * ROW;

  const marker = (kind: string) => `url(#${id}-${kind})`;

  return (
    <div className="flow-seq">
      <div ref={measure} className="thin-scroll overflow-x-auto">
        <div style={{ minWidth: inner, ["--lane-w" as string]: `${laneW - 12}px` }}>
          <div className="flow-grid flow-head">
            <span className="oh">{mode === "after" ? "now" : "was"}</span>
            <span className="oh">{mode === "diff" ? "now" : ""}</span>
            <span />
            <div className="flow-lanes">
              {lanes.map((p) => (
                <span
                  key={p.name}
                  className={`flow-who ${p.external ? "external" : ""}`}
                  style={{ left: x(p.name) }}
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
              width={laneW * lanes.length}
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
              {rows.map((row, i) => {
                const from = x(row.step.from);
                const to = x(row.step.to);
                const top = i * ROW;
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
              const left = from === to ? from + 28 : Math.min(from, to) + 8;
              const first = mode === "after" ? row.now : row.was;
              const second = mode === "diff" ? row.now : null;
              return (
                <div
                  key={row.key}
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
                    <span className="lab" style={{ left, maxWidth: `calc(100% - ${left + 8}px)` }}>
                      <span className="min-w-0 truncate">{row.step.label}</span>
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
              );
            })}
          </div>
        </div>
      </div>
      <div className="flow-foot">{footer}</div>
    </div>
  );
}
