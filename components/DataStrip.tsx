"use client";

import { useEffect, useRef, useState } from "react";

import type {
  Constraint,
  DataResponse,
  Diffed,
  EntityDiff,
  Field,
  Relationship,
} from "@/lib/data/types";
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
  tally(e.fields, "field");
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
  const target = r.polymorphic ? "any (polymorphic)" : (r.target ?? "?");
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

function EntityCard({ e }: { e: EntityDiff }) {
  const [all, setAll] = useState(false);
  const fields = all ? e.fields : changes(e.fields);
  const unchangedFields = e.fields.length - changes(e.fields).length;
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

export function DataStrip({ data }: { data: DataResponse | null }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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
          <div className="data-grid">
            {data.entities.map((e) => (
              <EntityCard key={e.name} e={e} />
            ))}
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--fg-subtle)]">
            From {data.source === "rails" ? "db/schema.rb and the models" : "the Core Data model"}, at the base and
            the head. Unchanged entities shown are the ones the changed entities relate to.
          </p>
        </div>
      )}
    </div>
  );
}
