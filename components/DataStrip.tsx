"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { present, type Presented } from "@/lib/data/present";
import type {
  Constraint,
  DataResponse,
  Diffed,
  EntityDiff,
  Field,
  Relationship,
} from "@/lib/data/types";
import { edgePath, layeredLayout } from "./graph";
import { ChevronDownIcon } from "./icons";

/**
 * The data model's change: a one-line strip under the map, opening the
 * changed entities as cards that diff like code. Between the components,
 * which are too coarse to show a field moving, and the flows, where a new
 * column is only a word in a step.
 */

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Level 1, the strip: which entities changed, in a phrase each. */
function summary(shown: Presented[]) {
  const changed = shown.filter((p) => p.state !== "same");
  if (changed.length === 0) return <>no data model change</>;
  const added = changed.filter((p) => p.state === "added");
  const removed = changed.filter((p) => p.state === "removed");
  const edited = changed.filter((p) => p.state === "changed");
  const parts: React.ReactNode[] = [];
  if (added.length) {
    parts.push(
      <span className="text-[var(--success)]">
        {added.map((p) => p.entity.name).join(", ")} {added.length === 1 ? "is" : "are"} new
      </span>,
    );
  }
  for (const p of edited) {
    parts.push(
      <>
        <b>{p.entity.name}</b> {p.summary}
      </>,
    );
  }
  if (removed.length) {
    parts.push(<span className="text-[var(--danger)]">{removed.map((p) => p.entity.name).join(", ")} removed</span>);
  }
  if (!added.length && !removed.length) parts.push(<>no new entities</>);
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && " · "}
      {part}
    </span>
  ));
}

const fieldType = (f: Field) => (f.values ? `enum (${f.values.join(", ")})` : f.type) + (f.required ? "" : "?");

function relText(r: Relationship) {
  const target = r.polymorphic
    ? `${r.candidates?.length ? r.candidates.join(" or ") : "anything"} (polymorphic)`
    : (r.target ?? "?");
  return `${r.name}: ${r.kind} ${target}${r.through ? ` through ${r.through}` : ""}`;
}

function ruleText(c: Constraint) {
  return c.kind === "unique"
    ? `unique (${c.fields.join(", ")})`
    : `${c.fields.join(", ")} → ${c.target ?? "?"}`;
}

function Row({ state, children, was }: { state: string; children: React.ReactNode; was?: string }) {
  return (
    <div className={`data-row ${state}`}>
      <span className="mark">{state === "added" ? "+" : state === "removed" ? "−" : state === "changed" ? "~" : ""}</span>
      <span className="text">
        {children}
        {was && <span className="was"> was {was}</span>}
      </span>
    </div>
  );
}

/**
 * One entity. Level 2: its name and one line. Click for level 3, the field
 * changes and any relationship the arrows don't already say. "Details" is
 * level 4: rules, the columns links live in, timestamps, unchanged fields.
 */
function EntityCard({ p, open, onToggle }: { p: Presented; open: boolean; onToggle: () => void }) {
  const [details, setDetails] = useState(false);
  const e = p.entity;
  if (p.state === "same") {
    return (
      <div className="data-card same compact" title={e.file ?? undefined}>
        <span className="name">{e.name}</span>
        {e.component && <span className="file-owner">{e.component}</span>}
      </div>
    );
  }
  const d = p.details;
  const hasDetails =
    d.rules.length + d.linkFields.length + d.timestamps.length + d.unchangedFields.length > 0;
  return (
    <div className={`data-card ${p.state} ${open ? "open" : ""}`} title={e.file ?? undefined}>
      <button type="button" className="data-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="name">{e.name}</span>
        {p.state === "added" && <span className="map-tag new">New</span>}
        {p.state === "removed" && <span className="map-tag removed">Removed</span>}
        <span className="flex-1" />
        {e.component && <span className="file-owner">{e.component}</span>}
      </button>
      <button type="button" className="data-card-line" onClick={onToggle}>
        <span>{p.state === "added" ? p.summary.replace(/^New · /, "") || "New" : p.summary}</span>
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <>
          {p.fields.length > 0 && (
            <div className="data-section">
              {p.fields.map((f) => (
                <Row key={f.item.name} state={f.state} was={f.before ? fieldType(f.before) : undefined}>
                  <span className="mono">{f.item.name}</span> <span className="type">{fieldType(f.item)}</span>
                </Row>
              ))}
            </div>
          )}
          {p.relationships.length > 0 && (
            <div className="data-section">
              {p.relationships.map((r) => (
                <Row key={r.item.name} state={r.state} was={r.before ? relText(r.before) : undefined}>
                  {relText(r.item)}
                </Row>
              ))}
            </div>
          )}
          {hasDetails && (
            <button type="button" className="data-more" onClick={() => setDetails((v) => !v)}>
              {details ? "Hide details" : "Details: rules, link columns, timestamps"}
            </button>
          )}
          {details && (
            <div className="data-section details">
              {d.rules.map((r, i) => (
                <Row key={`r${i}`} state={r.state}>
                  <span className="mono">{ruleText(r.item)}</span>
                </Row>
              ))}
              {[...d.linkFields, ...d.timestamps].map((f) => (
                <Row key={f.item.name} state={f.state}>
                  <span className="mono">{f.item.name}</span> <span className="type">{fieldType(f.item)}</span>
                </Row>
              ))}
              {d.unchangedFields.length > 0 && (
                <div className="data-note">
                  {count(d.unchangedFields.length, "unchanged field")}:{" "}
                  <span className="mono">{d.unchangedFields.map((f) => f.name).join(", ")}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface DataEdge {
  key: string;
  source: string;
  destination: string;
  label: string;
  state: Diffed<Relationship>["state"];
}

/**
 * The relationships to draw: each belongs-to from the entity holding the
 * link to the one it points at (a polymorphic one to each entity that fills
 * it), and many-to-many. A has-many is the other end of a belongs-to, so
 * drawing both would be one link twice.
 */
function dataEdges(entities: EntityDiff[], changed: Set<string>): DataEdge[] {
  const shown = new Set(entities.map((e) => e.name));
  const out: DataEdge[] = [];
  for (const e of entities) {
    for (const d of e.relationships) {
      const r = d.item;
      if (r.kind !== "belongs to" && r.kind !== "many to many") continue;
      const targets = r.polymorphic ? (r.candidates ?? []) : r.target ? [r.target] : [];
      for (const t of targets) {
        if (!shown.has(t) || t === e.name) continue;
        // An unchanged link is drawn only between two changed entities: the
        // rest is context that the cards' grey neighbours don't need.
        if (d.state === "same" && !(changed.has(e.name) && changed.has(t))) continue;
        out.push({
          key: `${e.name}.${r.name}→${t}`,
          source: e.name,
          destination: t,
          label: r.polymorphic ? `${r.name} (polymorphic)` : r.name,
          state: d.state,
        });
      }
    }
  }
  return out;
}

function DataGraph({ shown, width }: { shown: Presented[]; width: number }) {
  const changedNames = useMemo(
    () => new Set(shown.filter((p) => p.state !== "same").map((p) => p.entity.name)),
    [shown],
  );
  const edges = useMemo(
    () => dataEdges(shown.map((p) => p.entity), changedNames),
    [shown, changedNames],
  );
  // Changed entities, and only the neighbours a changed one links to.
  const nodes = useMemo(() => {
    const linked = new Set(edges.flatMap((e) => [e.source, e.destination]));
    return shown
      .filter((p) => p.state !== "same" || linked.has(p.entity.name))
      .map((p) => ({ ...p, id: p.entity.name }));
  }, [shown, edges]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const { placed, height } = useMemo(
    () =>
      layeredLayout(nodes, edges, width, (n) => heights.get(n.id) ?? (n.state === "same" ? 36 : 64), {
        minW: 220,
        maxW: 300,
        rowGap: 64,
        colGap: 22,
        pad: 12,
      }),
    [nodes, edges, width, heights],
  );

  // Cards size to what they hold, and grow when opened: lay out again
  // whenever any card's height changes.
  const measure = useCallback(() => {
    setHeights((current) => {
      const next = new Map<string, number>();
      let changed = false;
      for (const [id, el] of cards.current) {
        next.set(id, el.offsetHeight);
        if (Math.abs((current.get(id) ?? -1) - el.offsetHeight) > 1) changed = true;
      }
      return changed ? next : current;
    });
  }, []);
  useLayoutEffect(measure, [placed, measure]);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    for (const el of cards.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [nodes, measure]);

  const ends = useMemo(() => {
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    for (const e of [...edges].sort(
      (a, b) => (placed.get(a.destination)?.x ?? 0) - (placed.get(b.destination)?.x ?? 0),
    )) {
      out.set(e.source, [...(out.get(e.source) ?? []), e.key]);
      inn.set(e.destination, [...(inn.get(e.destination) ?? []), e.key]);
    }
    return { out, inn };
  }, [edges, placed]);

  const route = (e: DataEdge) => {
    const a = placed.get(e.source);
    const b = placed.get(e.destination);
    if (!a || !b) return null;
    const outs = ends.out.get(e.source) ?? [];
    const ins = ends.inn.get(e.destination) ?? [];
    return edgePath(a, b, outs.indexOf(e.key), outs.length, ins.indexOf(e.key), ins.length);
  };

  return (
    <div className="map-canvas" style={{ height }}>
      <svg className="map-edges" width={width} height={height}>
        <defs>
          {[
            ["quiet", "var(--fg-subtle)"],
            ["add", "var(--success)"],
            ["del", "var(--danger)"],
            ["chg", "var(--attention)"],
          ].map(([k, fill]) => (
            <marker key={k} id={`data-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 9 5 0 9z" style={{ fill }} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const r = route(e);
          if (!r) return null;
          const kind = e.state === "added" ? "add" : e.state === "removed" ? "del" : e.state === "changed" ? "chg" : "quiet";
          const cls = e.state === "same" ? "same data" : e.state;
          return (
            <g key={e.key} onMouseEnter={() => setHover(e.key)} onMouseLeave={() => setHover(null)}>
              <path d={r.d} className="map-hit" />
              <path d={r.d} className={`map-edge ${cls} ${hover === e.key ? "hover" : ""}`} markerEnd={`url(#data-${kind})`} />
              <title>{`${e.source} → ${e.destination}: ${e.label}`}</title>
            </g>
          );
        })}
      </svg>
      {edges.map((e) => {
        // Unchanged links label on hover, as on the map.
        if (e.state === "same" && hover !== e.key) return null;
        const r = route(e);
        if (!r) return null;
        return (
          <div key={e.key} className={`map-label ${e.state} data-edge-label`} style={{ left: r.lx, top: r.ly }}>
            {e.label}
          </div>
        );
      })}
      {[...placed.values()].map((n) => (
        <div
          key={n.id}
          ref={(el) => {
            if (el) cards.current.set(n.id, el);
            else cards.current.delete(n.id);
          }}
          className="data-placed"
          style={{ left: n.x, top: n.y, width: n.w }}
        >
          <EntityCard
            p={n}
            open={open.has(n.id)}
            onToggle={() =>
              setOpen((cur) => {
                const next = new Set(cur);
                if (next.has(n.id)) next.delete(n.id);
                else next.add(n.id);
                return next;
              })
            }
          />
        </div>
      ))}
    </div>
  );
}

export function DataStrip({ data }: { data: DataResponse | null }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width - 22)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

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

  const shown = useMemo(() => present(data?.entities ?? []), [data]);
  if (!data) return null;
  const changed = shown.filter((p) => p.state !== "same");
  if (data.status === "none" || changed.length === 0) {
    return (
      <div className="map-strip quiet">
        <span className="text-[13px] font-semibold">Data</span>
        <span className="text-[12px] text-[var(--fg-muted)]">
          ·{" "}
          {data.status === "none"
            ? "no data model found (db/schema.rb, or a Core Data model)"
            : data.baseModel
              ? "no data model change"
              : "no data model at base to compare with"}
        </span>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="map-strip">
      <div className="data-glyph" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
          <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">Data</div>
        <div className="truncate text-[12px] text-[var(--fg-muted)]">{summary(shown)}</div>
      </div>
      <button type="button" className="map-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide data" : "Show data"}
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="map-overlay">
          <div className="map-card">
            <DataGraph shown={shown} width={width} />
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--fg-subtle)]">
            From {data.source === "rails" ? "db/schema.rb and the models" : "the Core Data model"}, at the base and
            the head. Click an entity for its fields. Arrows point from the entity holding a link to
            the one it links to; grey boxes are unchanged entities a changed one links to.
          </p>
        </div>
      )}
    </div>
  );
}
