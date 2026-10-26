"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  shortLabels,
  type FlowMode,
  type FlowRow,
  type ParticipantGroup,
} from "@/lib/flows/rows";
import type { FlowParticipant } from "@/lib/flows/types";
import { STEP_CODE_H } from "./StepCode";

/** Row height, and where in the row the arrow runs. Matches the mockup. */
const ROW = 40;
const ARROW_Y = 30;
const GUTTER = 76;
const MIN_LANE = 84;
/** Below this, lane names alternate between two rows so they can be wider. */
const STAGGER_BELOW = 150;
/** A component box's name line, and the most lines its description may take. */
const BOX_NAME_H = 30;
const BOX_DESC_LINES = 6;
/** The box's padding below the lane names. */
const BOX_PAD = 16;
const NONE_OPEN = new Set<string>();
const NO_FIELDS: DataField[] = [];

/** A review comment on a step's line, drawn at the row's right edge. */
export interface StepBadge {
  /** The thread's id */
  id: string;
  /** Its number, oldest first */
  n: number;
}

/** A step by side and id, the same in every flow mode. */
export const badgeKey = (row: Pick<FlowRow, "side" | "step">) =>
  `${row.side}:${row.step.id}`;

export interface DataField {
  entity: string;
  field: string;
  state: "added" | "removed" | "changed";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The changed fields a step's call names. */
function fieldsIn(step: FlowRow["step"], fields: DataField[]) {
  const text = `${step.label} ${step.symbol}`;
  return fields
    .filter((f) => new RegExp(`\\b${escapeRe(f.field)}\\b`).test(text))
    .slice(0, 2);
}

/**
 * The sequence diagram: participants across the top, one call per row,
 * drawn as custom SVG on a row grid. No library: the rows are the diff's
 * rows, and a layout engine would only fight that.
 */
export interface ComponentInfo {
  description: string;
  state: "touched" | "added" | "removed" | "neighbour";
}

export function FlowSequence({
  rows,
  participants,
  groups,
  mode,
  activeKeys,
  onRowClick,
  open = NONE_OPEN,
  renderCode,
  components,
  dataFields = NO_FIELDS,
  badges,
  onBadge,
}: {
  rows: FlowRow[];
  participants: FlowParticipant[];
  /** Participants by component, in lane order */
  groups: ParticipantGroup[];
  mode: FlowMode;
  activeKeys: Set<string>;
  onRowClick: (row: FlowRow) => void;
  /** Rows whose code is open beneath them */
  open?: Set<string>;
  renderCode?: (row: FlowRow) => React.ReactNode;
  /** What the map says of each component: its description, and what the change did to it */
  components?: Map<string, ComponentInfo>;
  /** Fields the change added, removed or changed, for chips on the steps that use them */
  dataFields?: DataField[];
  /** Review comments on steps' lines, by `badgeKey` */
  badges?: Map<string, StepBadge[]>;
  /** A badge was clicked: open its comment */
  onBadge?: (threadId: string) => void;
}) {
  const id = useId().replace(/:/g, "");
  const measure = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = measure.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const labels = useMemo(() => shortLabels(participants), [participants]);
  const bandName = (g: ParticipantGroup) =>
    g.component ?? (g.external ? "Framework" : "Not on the map");

  // Lanes share the width; a component group gets at least the room its
  // name needs, so the name is never cut. Wider than the column scrolls.
  const laneW = Math.max(
    MIN_LANE,
    (width - GUTTER) / Math.max(participants.length, 1),
  );
  const spans: { g: ParticipantGroup; left: number; width: number }[] = [];
  const centre = new Map<string, number>();
  const laneWidth = new Map<string, number>();
  let cursor = 0;
  for (const g of groups) {
    const n = g.end - g.start + 1;
    // Wide enough for the component's name and for its widest lane name.
    const widestLane = Math.max(
      0,
      ...participants
        .slice(g.start, g.end + 1)
        .map((l) => (labels.get(l.name) ?? l.label).length * 7.2 + 34),
    );
    const w = Math.max(n * laneW, bandName(g).length * 7.6 + 32, widestLane);
    spans.push({ g, left: cursor, width: w });
    for (let k = 0; k < n; k++) {
      const p = participants[g.start + k];
      centre.set(p.name, cursor + (w * (k + 0.5)) / n);
      laneWidth.set(p.name, w / n);
    }
    cursor += w;
  }
  const area = Math.max(cursor, laneW * participants.length);

  // The boxes' title area is as tall as the longest description needs, so
  // nothing a box says is cut off.
  const boxes = spans.map((span) => {
    const { g, width: w } = span;
    const info = g.component ? components?.get(g.component) : undefined;
    const state = !g.component ? "plain" : (info?.state ?? "neighbour");
    const description = g.component
      ? info?.description
      : g.external
        ? "Framework and library types"
        : "Code the map doesn't place";
    const lines = description
      ? Math.min(
          BOX_DESC_LINES,
          Math.ceil((description.length * 6.5) / Math.max(40, w - 30)),
        )
      : 0;
    return { ...span, state, description, lines };
  });
  const BAND_H =
    BOX_NAME_H + Math.max(0, ...boxes.map((b) => b.lines)) * 16 + 6;
  const inner = GUTTER + area;
  const narrowest = Math.min(...[...laneWidth.values(), laneW]);
  const stagger = participants.length > 1 && narrowest < STAGGER_BELOW;
  const headH = (stagger ? 58 : 36) + BAND_H + BOX_PAD;
  const x = (name: string) => centre.get(name) ?? laneW / 2;
  const chipWidth = (name: string) =>
    (stagger ? 2 : 1) * (laneWidth.get(name) ?? laneW) - 12;
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
    const half =
      Math.min(
        chipWidth(p.name),
        (labels.get(p.name) ?? p.label).length * 7 + 18,
      ) / 2;
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
            <div className="flow-lanes" style={{ height: headH }}>
              {/* Each component drawn as the map draws it: a box holding its
                  lanes, named and described, marked by what the change did. */}
              {boxes.map(({ g, left, width: w, state, description }) => {
                return (
                  <div
                    key={g.start}
                    className={`flow-comp ${state}`}
                    style={{ left: left + 4, width: w - 8 }}
                    title={description ?? g.component ?? undefined}
                  >
                    <h4>
                      <span className="truncate">{bandName(g)}</span>
                      {state === "added" && (
                        <span className="map-tag new">New</span>
                      )}
                    </h4>
                    {description && <p>{description}</p>}
                  </div>
                );
              })}
              {/* Each lifeline starts at its type's name, through the box. */}
              {participants.map((p, i) => {
                const top = BAND_H + (stagger && i % 2 === 1 ? 31 : 6) + 11;
                return (
                  <span
                    key={`line-${p.name}`}
                    className="flow-lifeline"
                    style={{ left: x(p.name), top, height: headH - top }}
                  />
                );
              })}
              {participants.map((p, i) => (
                <span
                  key={p.name}
                  className={`flow-who ${p.external ? "external" : ""}`}
                  style={{
                    left: chipLeft(p),
                    top: BAND_H + (stagger && i % 2 === 1 ? 31 : 6),
                    maxWidth: chipWidth(p.name),
                  }}
                  title={[
                    p.name,
                    p.component && `in ${p.component}`,
                    p.external && "external",
                  ]
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
                    markerWidth="4.5"
                    markerHeight="4.5"
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
                  markerWidth="4.5"
                  markerHeight="4.5"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M1 1 9 5 1 9"
                    fill="none"
                    strokeWidth="1.5"
                    style={{ stroke: "var(--danger)" }}
                  />
                </marker>
              </defs>
              {participants.map((p) => (
                <line
                  key={p.name}
                  className="lifeline"
                  x1={x(p.name)}
                  x2={x(p.name)}
                  y1={0}
                  y2={height}
                />
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
              const text = [
                row.step.label,
                row.step.returns ? `→ ${row.step.returns}` : "",
              ].join(" ");
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
                    data-row={row.key}
                    className={`flow-grid flow-row k-${row.kind} ${activeKeys.has(row.key) ? "inview" : ""}`}
                    onClick={() => onRowClick(row)}
                    title={`${row.step.caller} · ${row.step.file}:${row.step.line}`}
                  >
                    <span className="n">{first ?? ""}</span>
                    <span className="n">{second ?? ""}</span>
                    <span className="m" />
                    <span className="l">
                      <span className="lab" style={place}>
                        <span className="call min-w-0 truncate">
                          {row.step.label}
                        </span>
                        {row.step.returns && (
                          <span className="ret min-w-0 shrink-[2] truncate">
                            → {row.step.returns}
                          </span>
                        )}
                        {row.step.repeat && (
                          <span className="flow-badge">
                            × {row.step.repeat}
                          </span>
                        )}
                        {row.again && (
                          <span className="flow-badge">{row.again}</span>
                        )}
                        {fieldsIn(row.step, dataFields).map((f) => (
                          <span
                            key={f.field}
                            className={`flow-badge data ${f.state}`}
                            title={`This step uses ${f.entity}.${f.field}, which the change ${f.state === "added" ? "adds" : f.state === "removed" ? "removes" : "changes"}`}
                          >
                            {f.entity}.{f.field}{" "}
                            {f.state === "added" ? "new" : f.state}
                          </span>
                        ))}
                        {!row.step.verified && (
                          <span
                            className="flow-badge warn"
                            title={`"${row.step.symbol}" isn't on ${row.step.file}:${row.step.line}`}
                          >
                            unverified
                          </span>
                        )}
                      </span>
                      {(badges?.get(badgeKey(row)) ?? []).length > 0 && (
                        <span className="row-badges">
                          {badges?.get(badgeKey(row))?.map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              className="mark c"
                              title={`Review comment ${b.n}: open it in Comments`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onBadge?.(b.id);
                              }}
                            >
                              💬 {b.n}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                  </div>
                  {open.has(row.key) && (
                    // Pinned to the visible part of a card that scrolls sideways.
                    <div
                      className="step-code-slot"
                      style={{ width: width || undefined }}
                    >
                      {renderCode?.(row)}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
