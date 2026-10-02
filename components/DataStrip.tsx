"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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

const changes = <T,>(list: Diffed<T>[]) => list.filter((d) => d.state !== "same");

function count(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Columns that only hold a link (source_type, source_id) belong to their
 * relationship, not the field list: a polymorphic link is one change, not
 * two new fields and a relationship.
 */
export function linkFields(e: EntityDiff): Set<string> {
  return new Set(e.relationships.flatMap((r) => r.item.fields ?? []));
}

/** "Item +3 fields, +1 rule": what happened to one entity, in a phrase. */
function entityPhrase(e: EntityDiff) {
  const parts: string[] = [];
  const tally = (list: Diffed<unknown>[], word: string) => {
    const added = list.filter((d) => d.state === "added").length;
    const removed = list.filter((d) => d.state === "removed").length;
    const changed = list.filter((d) => d.state === "changed").length;
    const bits = [added && `+${added}`, removed && `−${removed}`, changed && `~${changed}`].filter(Boolean);
    if (bits.length) parts.push(`${bits.join(" ")} ${word}${added + removed + changed === 1 ? "" : "s"}`);
  };
  const links = linkFields(e);
  tally(
    e.fields.filter((f) => !links.has(f.item.name)),
    "field",
  );
  tally(e.relationships, "relationship");
  tally(e.constraints, "rule");
  return parts.join(", ");
}

function summary(data: DataResponse) {
  const changed = data.entities.filter((e) => e.state !== "same");
  if (changed.length === 0) return <>no data model change</>;
  const added = changed.filter((e) => e.state === "added");
  const removed = changed.filter((e) => e.state === "removed");
  const edited = changed.filter((e) => e.state === "changed");
  const parts: React.ReactNode[] = [];
  if (added.length) {
    parts.push(
      <span className="text-[var(--success)]">
        {added.map((e) => e.name).join(", ")} {added.length === 1 ? "is" : "are"} new
      </span>,
    );
  }
  for (const e of edited) {
    parts.push(
      <>
        <b>{e.name}</b> {entityPhrase(e)}
      </>,
    );
  }
  if (removed.length) {
    parts.push(<span className="text-[var(--danger)]">{removed.map((e) => e.name).join(", ")} removed</span>);
  }
  if (!added.length) parts.push(<>no new entities</>);
  return parts.map((p, i) => (
    <span key={i}>
      {i > 0 && " · "}
      {p}
    </span>
  ));
}

const fieldType = (f: Field) => (f.values ? `enum (${f.values.join(", ")})` : f.type) + (f.required ? "" : "?");

function relText(r: Relationship) {
  const target = r.polymorphic
    ? `${r.candidates?.length ? r.candidates.join(" or ") : "anything"} (polymorphic)`
    : (r.target ?? "?");
  const as = r.as ? `, as its ${r.as}` : "";
  return `${r.name}: ${r.kind} ${target}${as}${r.through ? ` through ${r.through}` : ""}`;
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

export function EntityCard({ e }: { e: EntityDiff }) {
  const [all, setAll] = useState(false);
  const links = linkFields(e);
  const own = e.fields.filter((f) => !links.has(f.item.name));
  const fields = all ? own : changes(own);
  const unchangedFields = own.length - changes(own).length;
  const neighbour = e.state === "same";
  return (
    <div className={`data-card ${e.state}`} title={e.file ?? undefined}>
      <div className="data-card-head">
        <span className="name">{e.name}</span>
        {e.state === "added" && <span className="map-tag new">New</span>}
        {e.state === "removed" && <span className="map-tag removed">Removed</span>}
        <span className="flex-1" />
        {e.component && <span className="file-owner">{e.component}</span>}
      </div>
      {neighbour ? (
        <div className="data-note">
          Unchanged · {count(e.fields.length, "field")}
          {e.relationships.length > 0 && ` · ${count(e.relationships.length, "relationship")}`}
        </div>
      ) : (
        <>
          {(fields.length > 0 || unchangedFields > 0) && (
            <div className="data-section">
              {fields.map((d) => (
                <Row key={d.item.name} state={d.state} was={d.before ? fieldType(d.before) : undefined}>
                  <span className="mono">{d.item.name}</span> <span className="type">{fieldType(d.item)}</span>
                </Row>
              ))}
              {unchangedFields > 0 && (
                <button type="button" className="data-more" onClick={() => setAll((v) => !v)}>
                  {all ? "Hide unchanged fields" : `+ ${count(unchangedFields, "unchanged field")}`}
                </button>
              )}
            </div>
          )}
          {changes(e.relationships).length > 0 && (
            <div className="data-section">
              <div className="data-label">Relationships</div>
              {changes(e.relationships).map((d) => (
                <Row key={d.item.name} state={d.state} was={d.before ? relText(d.before) : undefined}>
                  {relText(d.item)}
                  {d.item.fields && d.item.fields.length > 0 && (
                    <span className="via">
                      {" "}
                      via <span className="mono">{d.item.fields.join(", ")}</span>
                    </span>
                  )}
                </Row>
              ))}
            </div>
          )}
          {changes(e.constraints).length > 0 && (
            <div className="data-section">
              <div className="data-label">Rules</div>
              {changes(e.constraints).map((d, i) => (
                <Row key={i} state={d.state}>
                  <span className="mono">{ruleText(d.item)}</span>
                </Row>
              ))}
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
function dataEdges(entities: EntityDiff[]): DataEdge[] {
  const shown = new Set(entities.map((e) => e.name));
  // Links between two unchanged neighbours aren't this change's story.
  const changed = new Set(entities.filter((e) => e.state !== "same").map((e) => e.name));
  const out: DataEdge[] = [];
  for (const e of entities) {
    for (const d of e.relationships) {
      const r = d.item;
      if (r.kind !== "belongs to" && r.kind !== "many to many") continue;
      const targets = r.polymorphic ? (r.candidates ?? []) : r.target ? [r.target] : [];
      for (const t of targets) {
        if (!shown.has(t) || t === e.name) continue;
        if (d.state === "same" && !changed.has(e.name) && !changed.has(t)) continue;
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

function DataGraph({ entities, width }: { entities: EntityDiff[]; width: number }) {
  const nodes = useMemo(() => entities.map((e) => ({ ...e, id: e.name })), [entities]);
  const edges = useMemo(() => dataEdges(entities), [entities]);
  const [heights, setHeights] = useState<Map<string, number>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const { placed, height } = useMemo(
    () =>
      layeredLayout(nodes, edges, width, (n, w) => heights.get(n.id) ?? estimateCard(n, w), {
        minW: 250,
        maxW: 320,
        rowGap: 64,
        colGap: 22,
        pad: 12,
      }),
    [nodes, edges, width, heights],
  );

  // Cards size to what they hold; lay out again with their real heights.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    let changed = false;
    for (const [id, el] of cards.current) {
      next.set(id, el.offsetHeight);
      if (Math.abs((heights.get(id) ?? -1) - el.offsetHeight) > 1) changed = true;
    }
    if (changed) setHeights(next);
  }, [placed, heights]);

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
          <EntityCard e={n} />
        </div>
      ))}
    </div>
  );
}

/** A card's height before it's measured: its header, and a line per change shown. */
function estimateCard(e: EntityDiff, _w: number) {
  if (e.state === "same") return 56;
  const lines = [...e.fields, ...e.relationships, ...e.constraints].filter((d) => d.state !== "same").length;
  return 40 + lines * 22 + 30;
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

  if (!data) return null;
  const changed = data.entities.filter((e) => e.state !== "same");
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
        <div className="truncate text-[12px] text-[var(--fg-muted)]">{summary(data)}</div>
      </div>
      <button type="button" className="map-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide data" : "Show data"}
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="map-overlay">
          <div className="map-card">
            <DataGraph entities={data.entities} width={width} />
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--fg-subtle)]">
            From {data.source === "rails" ? "db/schema.rb and the models" : "the Core Data model"}, at the base and
            the head. Arrows point from the entity holding a link to the one it links to; unchanged
            entities shown are the ones the changed entities relate to.
          </p>
        </div>
      )}
    </div>
  );
}
