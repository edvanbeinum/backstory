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
import { viewKey, viewParams } from "@/lib/url";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { edgePath, layeredLayout } from "./graph";
import { AlertIcon, ChevronDownIcon } from "./icons";
import { Elapsed, setAutoReading } from "./SystemMap";
import { Badge, Button, Spinner } from "./ui";
import { useView } from "./ViewContext";

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
    ? `unique (${c.fields.join(", ")})`
    : `${c.fields.join(", ")} → ${c.target ?? "?"}`;
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
function dataEdges(
  entities: EntityDiff[],
  changed: Set<string>,
  whole: boolean,
): DataEdge[] {
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
        // rest is context that the cards' grey neighbours don't need. With
        // nothing changed, the whole model is the point, links and all.
        if (
          d.state === "same" &&
          !whole &&
          !(changed.has(e.name) && changed.has(t))
        )
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
  const whole = changedNames.size === 0;
  const edges = useMemo(
    () =>
      dataEdges(
        shown.map((p) => p.entity),
        changedNames,
        whole,
      ),
    [shown, changedNames, whole],
  );
  // Changed entities, and only the neighbours a changed one links to.
  const nodes = useMemo(() => {
    const linked = new Set(edges.flatMap((e) => [e.source, e.destination]));
    return shown
      .filter((p) => whole || p.state !== "same" || linked.has(p.entity.name))
      .map((p) => ({ ...p, id: p.entity.name }));
  }, [shown, edges, whole]);
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
  const { ref } = useView();
  const viewId = viewKey({ repo, ref, rev });
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
  // Tags an answer with the page's latest read of the view when it arrives,
  // not the read it was sent over: a page read that lands while a read starts
  // says idle, and would hide the answer that says running, so nothing would
  // poll. A page read that lands after the answer still replaces it.
  const latest = useRef({ view: viewId, given });
  // Try again repeats the last read: a Redraft only when that was a Redraft,
  // since one reads main in full and removes every derived model.
  const lastRedraft = useRef(false);
  useEffect(() => {
    latest.current = { view: viewId, given };
  }, [viewId, given]);

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
        const response = await fetch(`/api/data?${params}`, {
          method,
          cache: "no-store",
        });
        // A data response can carry `error` too, a steer's: only a failed
        // response is a failed request.
        const body = (await response.json()) as
          DataResponse | { error?: string };
        if (!response.ok || !("readers" in body)) {
          const at = over();
          if (at !== undefined)
            setError({ over: at, message: body.error ?? response.statusText });
          return;
        }
        const at = over();
        if (at === undefined) return;
        setError(null);
        setAnswer({ over: at, data: body });
        // The page reads the data again once a read ends, so everything
        // that shows the data model sees the drafted one.
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

  const data = answer?.over === given ? answer.data : given;
  const running = data?.draft?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  // With reading turned on, a view with no model yet starts its read on
  // open, once per view: a read that fails or can't run doesn't start again.
  const autoStart =
    data?.status === "none" && data.draft?.status === "idle" && data.draft.auto;
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStart || autoStarted.current === viewId) return;
    autoStarted.current = viewId;
    void request("POST");
  }, [autoStart, viewId, request]);

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
    data,
    error: error?.over === given ? error.message : null,
    start: (redraft = false) => void request("POST", redraft),
    retry: () => void request("POST", lastRedraft.current),
    turnOn: () => void setAuto(true),
    turnOff: () => void setAuto(false),
  };
}

function DraftedBadge() {
  return (
    <Badge tone="draft" className="!py-0 !leading-4">
      Read by AI
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
        <Button size="sm" onClick={draft.retry}>
          Try again
        </Button>
      </span>
    );
  if (job?.status === "unavailable")
    return (
      <span className="text-[12px] text-[var(--attention)]">
        <ClaudeCodeNotice
          reason={job.reason}
          needs="Reading the data model needs"
        />
      </span>
    );
  return null;
}

/** What a view with no data model shows: the formats looked for, and the offer to read one. */
function DraftOffer({ data, draft }: { data: DataResponse; draft: DraftApi }) {
  const job = data.draft;
  const idle =
    !job ||
    job.status === "idle" ||
    job.status === "unavailable" ||
    job.status === "done";
  const provider = job?.status === "idle" ? job.provider : null;
  const offerAuto = job?.status === "idle" && !job.auto;
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
            Read the data model
          </Button>
        )}
        {offerAuto && (
          <Button size="sm" onClick={draft.turnOn}>
            Read automatically
          </Button>
        )}
        <DraftProgress data={data} draft={draft} />
      </div>
      {provider && (
        <span className="text-[11px] text-[var(--fg-subtle)]">
          {provider} reads the code, read-only: main&apos;s data model once,
          then only what the diff changes. The first read can take a few minutes
          and uses your {provider} account. The result is kept on this machine.
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
                `Read the data model again? ${data.drafted?.provider ?? "The AI provider"} reads main's data model again in full and works out this view from it, which can take a few minutes on your account. Other views are worked out again as you open them. The current reading is kept if it fails.`,
              )
            )
              draft.start(true);
          }}
        >
          Read again
        </Button>
      )}
      <DraftProgress data={data} draft={draft} />
    </span>
  );
}

/** A drafted view's footnote: whether reads start by themselves, Turn off or Read automatically, and Read again. */
function DraftFootnote({
  data,
  draft,
}: {
  data: DataResponse;
  draft: DraftApi;
}) {
  const parts: React.ReactNode[] = [];
  if (data.auto)
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
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-[var(--fg-subtle)]">
        {parts.map((part, i) => (
          <span key={i}>
            {i > 0 && " · "}
            {part}
          </span>
        ))}
      </span>
      <Redraft data={data} draft={draft} />
    </span>
  );
}

/**
 * The data model's part of the line under the map. Its parts sit in the
 * line's wrapping row; the graph opens on a row of its own beneath it,
 * pushing the flows down.
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
  const shown = useMemo(() => present(data?.entities ?? []), [data]);
  const changed = shown.filter((p) => p.state !== "same");
  // Open the graph when the view changes the data model, and keep a click's
  // open or close only for the view it was made on.
  const { ref } = useView();
  const view = viewKey({ repo, ref, rev });
  const [toggled, setToggled] = useState<{ view: string; open: boolean }>();
  const open = toggled?.view === view ? toggled.open : changed.length > 0;
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

  if (!data) return null;
  if (data.status === "none") {
    return (
      <span className="part inline-flex min-w-0 items-start gap-1.5">
        <b>Data</b>
        <DraftOffer data={data} draft={draft} />
      </span>
    );
  }
  const noChange = data.baseModel
    ? "no data model change"
    : "no data model at base to compare with";
  // A drafted view with no change still has its whole model to look at.
  if (changed.length === 0 && !(data.drafted && shown.length > 0)) {
    return (
      <span className="part inline-flex flex-wrap items-center gap-1.5">
        <b>Data</b>
        {data.drafted && <DraftedBadge />}
        {noChange}
        {data.drafted && <DraftFootnote data={data} draft={draft} />}
      </span>
    );
  }

  const whole = changed.length === 0;
  return (
    <>
      <span className="part inline-flex min-w-0 flex-wrap items-center gap-1.5">
        <b>Data</b>
        {data.drafted && <DraftedBadge />}
        <span>{whole ? noChange : summary(shown)}</span>
        <button
          type="button"
          className="story-disclose"
          aria-expanded={open}
          onClick={() => setToggled({ view, open: !open })}
        >
          {open ? "Hide data" : "Show data"}
          <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
        </button>
        {whole && !open && <DraftFootnote data={data} draft={draft} />}
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
              ? `Read by ${data.drafted.provider} from the code: main once in full, then updated from what each diff changes. It may be wrong.`
              : `From ${data.label}, at the base and the head.`}{" "}
            {whole
              ? `Every entity at the head; ${data.baseModel ? "this change touches none of them" : "there is no data model at the base to compare with"}. Arrows point from the entity that has a link to the one it links to.`
              : "Click an entity for its fields. Arrows point from the entity that has a link to the one it links to; grey boxes are unchanged entities a changed one links to."}
          </p>
          {data.drafted && (
            <div className="px-1">
              <DraftFootnote data={data} draft={draft} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
