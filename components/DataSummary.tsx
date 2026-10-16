"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { present, type Presented } from "@/lib/data/present";
import type {
  Constraint,
  DataResponse,
  Diffed,
  EntityDiff,
  Field,
  Relationship,
} from "@/lib/data/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { edgePath, layeredLayout } from "./graph";
import { AlertIcon, ChevronDownIcon } from "./icons";
import { Elapsed } from "./SystemMap";
import { Badge, Button, Spinner } from "./ui";

/**
 * The data model's change: a phrase on the line under the map, opening the
 * changed entities beneath it as cards that diff like code. Between the
 * components, which are too coarse to show a field moving, and the flows,
 * where a new column is only a word in a step.
 */

/** Level 1, the phrase: which entities changed, in a phrase each. */
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
        {added.map((p) => p.entity.name).join(", ")}{" "}
        {added.length === 1 ? "is" : "are"} new
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
    parts.push(
      <span className="text-[var(--danger)]">
        {removed.map((p) => p.entity.name).join(", ")} removed
      </span>,
    );
  }
  if (!added.length && !removed.length) parts.push(<>no new entities</>);
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && " · "}
      {part}
    </span>
  ));
}

const fieldType = (f: Field) =>
  (f.values ? `enum (${f.values.join(", ")})` : f.type) +
  (f.required ? "" : "?");

function relText(r: Relationship) {
  const target = r.polymorphic
    ? `${r.candidates?.length ? r.candidates.join(" or ") : "anything"} (polymorphic)`
    : (r.target ?? "?");
  return `${r.name}: ${r.kind} ${target}${r.through ? ` through ${r.through}` : ""}`;
}

function ruleText(c: Constraint) {
  return c.kind === "unique"
    ? `unique (${c.fields.join(", ")})${c.condition ? ` where ${c.condition}` : ""}`
    : `${c.fields.join(", ")} → ${c.target ?? "?"}${c.targetFields ? ` (${c.targetFields.join(", ")})` : ""}`;
}

function Row({
  state,
  children,
  was,
}: {
  state: string;
  children: React.ReactNode;
  was?: string;
}) {
  return (
    <div className={`data-row ${state}`}>
      <span className="mark">
        {state === "added"
          ? "+"
          : state === "removed"
            ? "−"
            : state === "changed"
              ? "~"
              : ""}
      </span>
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
 * level 4: rules, the columns links live in, timestamps. Unchanged fields
 * aren't shown at all: they're the code's business, not the change's.
 */
function EntityCard({
  p,
  open,
  onToggle,
  notes = [],
}: {
  p: Presented;
  open: boolean;
  onToggle: () => void;
  /** "Worth a look" notes pinned on this entity */
  notes?: string[];
}) {
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
    d.rules.length + d.linkFields.length + d.timestamps.length > 0;
  return (
    <div
      className={`data-card ${p.state} ${open ? "open" : ""}`}
      title={e.file ?? undefined}
    >
      <button
        type="button"
        className="data-card-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="name">{e.name}</span>
        {p.state === "added" && <span className="map-tag new">New</span>}
        {p.state === "removed" && (
          <span className="map-tag removed">Removed</span>
        )}
        <span className="flex-1" />
        {e.component && <span className="file-owner">{e.component}</span>}
      </button>
      <button type="button" className="data-card-line" onClick={onToggle}>
        <span>
          {p.state === "added"
            ? p.summary.replace(/^New · /, "") || "New"
            : p.summary}
        </span>
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>
      {notes.map((n) => (
        <div key={n} className="pinned-note">
          {n}
        </div>
      ))}
      {open && (
        <>
          {p.fields.length > 0 && (
            <div className="data-section">
              {p.fields.map((f) => (
                <Row
                  key={f.item.name}
                  state={f.state}
                  was={f.before ? fieldType(f.before) : undefined}
                >
                  <span className="mono">{f.item.name}</span>{" "}
                  <span className="type">{fieldType(f.item)}</span>
                </Row>
              ))}
            </div>
          )}
          {p.relationships.length > 0 && (
            <div className="data-section">
              {p.relationships.map((r) => (
                <Row
                  key={r.item.name}
                  state={r.state}
                  was={r.before ? relText(r.before) : undefined}
                >
                  {relText(r.item)}
                </Row>
              ))}
            </div>
          )}
          {hasDetails && (
            <button
              type="button"
              className="data-more"
              onClick={() => setDetails((v) => !v)}
            >
              {details
                ? "Hide details"
                : "Details: rules, link columns, timestamps"}
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
                  <span className="mono">{f.item.name}</span>{" "}
                  <span className="type">{fieldType(f.item)}</span>
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
function dataEdges(entities: EntityDiff[], changed: Set<string>): DataEdge[] {
  const shown = new Set(entities.map((e) => e.name));
  const out: DataEdge[] = [];
  for (const e of entities) {
    for (const d of e.relationships) {
      const r = d.item;
      if (r.kind !== "belongs to" && r.kind !== "many to many") continue;
      const targets = r.polymorphic
        ? (r.candidates ?? [])
        : r.target
          ? [r.target]
          : [];
      for (const t of targets) {
        if (!shown.has(t) || t === e.name) continue;
        // An unchanged link is drawn only between two changed entities: the
        // rest is context that the cards' grey neighbours don't need.
        if (d.state === "same" && !(changed.has(e.name) && changed.has(t)))
          continue;
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

function DataGraph({
  shown,
  width,
  notes,
}: {
  shown: Presented[];
  width: number;
  notes?: Map<string, string[]>;
}) {
  const changedNames = useMemo(
    () =>
      new Set(
        shown.filter((p) => p.state !== "same").map((p) => p.entity.name),
      ),
    [shown],
  );
  const edges = useMemo(
    () =>
      dataEdges(
        shown.map((p) => p.entity),
        changedNames,
      ),
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
      layeredLayout(
        nodes,
        edges,
        width,
        (n) => heights.get(n.id) ?? (n.state === "same" ? 36 : 64),
        {
          minW: 220,
          maxW: 300,
          rowGap: 64,
          colGap: 22,
          pad: 12,
        },
      ),
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
        if (Math.abs((current.get(id) ?? -1) - el.offsetHeight) > 1)
          changed = true;
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
      (a, b) =>
        (placed.get(a.destination)?.x ?? 0) -
        (placed.get(b.destination)?.x ?? 0),
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
    return edgePath(
      a,
      b,
      outs.indexOf(e.key),
      outs.length,
      ins.indexOf(e.key),
      ins.length,
    );
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
            <marker
              key={k}
              id={`data-${k}`}
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
          const r = route(e);
          if (!r) return null;
          const kind =
            e.state === "added"
              ? "add"
              : e.state === "removed"
                ? "del"
                : e.state === "changed"
                  ? "chg"
                  : "quiet";
          const cls = e.state === "same" ? "same data" : e.state;
          return (
            <g
              key={e.key}
              onMouseEnter={() => setHover(e.key)}
              onMouseLeave={() => setHover(null)}
            >
              <path d={r.d} className="map-hit" />
              <path
                d={r.d}
                className={`map-edge ${cls} ${hover === e.key ? "hover" : ""}`}
                markerEnd={`url(#data-${kind})`}
              />
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
          <div
            key={e.key}
            className={`map-label ${e.state} data-edge-label`}
            style={{ left: r.lx, top: r.ly }}
          >
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
            notes={notes?.get(n.id)}
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

type DraftApi = ReturnType<typeof useDataDraft>;

/**
 * The view's data, replaced by what a draft request answered until the page
 * reads it again. Polls while a read runs rather than adding a watch event:
 * reads are rare.
 */
function useDataDraft(
  repo: string,
  rev: string,
  given: DataResponse | null,
  onRead: () => void,
) {
  const [answer, setAnswer] = useState<{
    over: DataResponse | null;
    data: DataResponse;
  } | null>(null);
  const [error, setError] = useState<{
    over: DataResponse | null;
    message: string;
  } | null>(null);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  const request = useCallback(
    async (method: "GET" | "POST", redraft = false) => {
      const params = new URLSearchParams({ repo, rev });
      if (redraft) params.set("redraft", "1");
      try {
        const response = await fetch(`/api/data?${params}`, {
          method,
          cache: "no-store",
        });
        // A data response can carry `error` too, a steer's: only a failed
        // response is a failed request.
        const body = (await response.json()) as
          DataResponse | { error?: string };
        if (!response.ok || !("readers" in body)) {
          setError({
            over: given,
            message: body.error ?? response.statusText,
          });
          return;
        }
        setError(null);
        setAnswer({ over: given, data: body });
        // The page reads the data again once a read ends, so everything
        // that shows the data model sees the drafted one.
        if (body.draft?.status !== "running") onReadRef.current();
      } catch (err) {
        setError({
          over: given,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [repo, rev, given],
  );

  const data = answer?.over === given ? answer.data : given;
  const running = data?.draft?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  return {
    data,
    error: error?.over === given ? error.message : null,
    start: (redraft = false) => void request("POST", redraft),
  };
}

function DraftedBadge() {
  return (
    <Badge tone="draft" className="!py-0 !leading-4">
      Draft
    </Badge>
  );
}

function DraftProgress({
  data,
  draft,
}: {
  data: DataResponse;
  draft: DraftApi;
}) {
  const job = data.draft;
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
        <Button size="sm" onClick={() => draft.start(Boolean(data.drafted))}>
          Try again
        </Button>
      </span>
    );
  if (job?.status === "unavailable")
    return (
      <span className="text-[12px] text-[var(--attention)]">
        <ClaudeCodeNotice
          reason={job.reason}
          needs="Drafting the data model needs"
        />
      </span>
    );
  return null;
}

/** What a view with no data model shows: the formats looked for, and the offer to draft one. */
function DraftOffer({ data, draft }: { data: DataResponse; draft: DraftApi }) {
  const job = data.draft;
  const idle =
    !job ||
    job.status === "idle" ||
    job.status === "unavailable" ||
    job.status === "done";
  const provider = job?.status === "idle" ? job.provider : null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {data.error ? (
          <span className="flex items-center gap-1 text-[12px] text-[var(--attention)]">
            <AlertIcon size={11} /> {data.error}
          </span>
        ) : (
          <span>no data model found ({data.readers.join(", ")})</span>
        )}
        {job && idle && (
          <Button size="sm" variant="primary" onClick={() => draft.start()}>
            Draft the data model
          </Button>
        )}
        <DraftProgress data={data} draft={draft} />
      </div>
      {provider && (
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {provider} reads the code at the head, read-only, and works out the
          base from the change. It can take a few minutes and uses your{" "}
          {provider} account. The result is kept on this machine.
        </span>
      )}
    </div>
  );
}

function Redraft({ data, draft }: { data: DataResponse; draft: DraftApi }) {
  const running = data.draft?.status === "running";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {!running && (
        <Button
          size="sm"
          variant="invisible"
          onClick={() => {
            if (
              window.confirm(
                `Redraft the data model? ${data.drafted?.provider ?? "The AI provider"} reads the code again, which can take a few minutes on your account. The current reading is kept if it fails.`,
              )
            )
              draft.start(true);
          }}
        >
          Redraft
        </Button>
      )}
      <DraftProgress data={data} draft={draft} />
    </span>
  );
}

/**
 * The data model's part of the line under the map. Its parts sit in the
 * line's wrapping row; `Show data` opens the graph on a row of its own
 * beneath it, pushing the flows down.
 */
export function DataSummary({
  data: given,
  notes,
  repo,
  rev,
  onRead,
}: {
  data: DataResponse | null;
  notes?: Map<string, string[]>;
  repo: string;
  rev: string;
  /** A drafted data model was read: read the data again */
  onRead: () => void;
}) {
  const draft = useDataDraft(repo, rev, given, onRead);
  const data = draft.data;
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const shown = useMemo(() => present(data?.entities ?? []), [data]);
  if (!data) return null;
  const changed = shown.filter((p) => p.state !== "same");
  if (data.status === "none") {
    return (
      <span className="part inline-flex min-w-0 items-start gap-1.5">
        <b>Data</b>
        <DraftOffer data={data} draft={draft} />
      </span>
    );
  }
  if (changed.length === 0) {
    return (
      <span className="part inline-flex flex-wrap items-center gap-1.5">
        <b>Data</b>
        {data.drafted && <DraftedBadge />}
        {data.baseModel
          ? "no data model change"
          : "no data model at base to compare with"}
        {data.drafted && <Redraft data={data} draft={draft} />}
      </span>
    );
  }

  return (
    <>
      <span className="part inline-flex min-w-0 flex-wrap items-center gap-1.5">
        <b>Data</b>
        {data.drafted && <DraftedBadge />}
        <span>{summary(shown)}</span>
        <button
          type="button"
          className="story-disclose"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide data" : "Show data"}
          <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
        </button>
      </span>
      {open && (
        <div ref={boxRef} className="basis-full pt-1">
          <div className="map-card">
            {width > 0 && (
              <DataGraph shown={shown} width={width - 2} notes={notes} />
            )}
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--fg-subtle)]">
            {data.drafted
              ? `Drafted by ${data.drafted.provider} from the code at the head, with the base worked out from the change. It may be wrong.`
              : `From ${data.label}, at the base and the head.`}{" "}
            Click an entity for its fields. Arrows point from the entity holding
            a link to the one it links to; grey boxes are unchanged entities a
            changed one links to.
          </p>
          {data.drafted && (
            <div className="px-1">
              <Redraft data={data} draft={draft} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
