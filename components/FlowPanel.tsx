"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { lanesFor, summarise, type FlowMode, type FlowRow } from "@/lib/flows/rows";
import type { FlowSet } from "@/lib/flows/types";
import { FlowSequence } from "./FlowSequence";
import { AlertIcon, ChevronRightIcon, SyncIcon } from "./icons";
import { Spinner } from "./ui";
import type { FlowsApi } from "./useFlows";

/** The reading line: where in the window the diff is being read. */
const READING_LINE = 0.4;

export interface FlowSelection {
  index: number;
  mode: FlowMode;
}

/** Ask the diff to show a line that's outside the hunks on screen. */
export function revealLine(path: string, side: "old" | "new", line: number) {
  window.dispatchEvent(new CustomEvent("differ:reveal", { detail: { path, side, line } }));
}

const anchorFor = (key: string) =>
  document.querySelector<HTMLElement>(`tr[data-flow-steps~="${CSS.escape(key)}"]`);

function scrollToReadingLine(el: HTMLElement) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top: window.scrollY + el.getBoundingClientRect().top - window.innerHeight * READING_LINE + 10,
    behavior: smooth ? "smooth" : "auto",
  });
}

export function FlowPanel({
  api,
  selection,
  onSelect,
  rows,
  filesInDiff,
  navRef,
  coverage,
}: {
  api: FlowsApi;
  selection: FlowSelection;
  onSelect: (next: FlowSelection) => void;
  /** The selected flow's rows in the selected mode */
  rows: FlowRow[];
  /** Paths the diff on screen shows, old and new */
  filesInDiff: Set<string>;
  /** j/k move through steps while the Flows tab is open */
  navRef: React.MutableRefObject<((delta: number) => void) | null>;
  coverage: React.ReactNode;
}) {
  const { status, error } = api;

  if (error) {
    return (
      <Notice tone="danger">
        Couldn&apos;t load flows: {error}{" "}
        <button type="button" className="text-[var(--accent)]" onClick={api.retry}>
          Try again
        </button>
      </Notice>
    );
  }
  if (!status) {
    return (
      <Notice>
        <Spinner /> Loading flows…
      </Notice>
    );
  }
  if (status.status === "unavailable") {
    return status.reason === "uncommitted" ? (
      <Notice>
        Flows are traced for commits. Pick a commit, or All changes, to see what the code
        does for each user action it touches.
      </Notice>
    ) : (
      <Notice tone="attention">
        Flows need Claude Code: differ runs <code className="mono">claude -p</code> with your
        login, and couldn&apos;t find <code className="mono">claude</code> on its PATH. The rest of
        differ works without it.{" "}
        <button type="button" className="text-[var(--accent)]" onClick={api.retry}>
          Look again
        </button>
      </Notice>
    );
  }
  if (status.status === "idle" || status.status === "running") {
    return <Generating startedAt={status.status === "running" ? status.startedAt : null} phase={status.status === "running" ? status.phase : "Starting"} />;
  }
  if (status.status === "failed") {
    return (
      <Notice tone="danger">
        Tracing flows failed: <span className="mono text-[11px]">{status.error}</span>{" "}
        <button type="button" className="text-[var(--accent)]" onClick={api.retry}>
          Try again
        </button>
      </Notice>
    );
  }

  return (
    <ReadyFlows
      set={status.flows}
      api={api}
      selection={selection}
      onSelect={onSelect}
      rows={rows}
      filesInDiff={filesInDiff}
      navRef={navRef}
      coverage={coverage}
      traceError={status.traceError}
    />
  );
}

function ReadyFlows({
  set,
  api,
  selection,
  onSelect,
  rows,
  filesInDiff,
  navRef,
  coverage,
  traceError,
}: {
  set: FlowSet;
  api: FlowsApi;
  selection: FlowSelection;
  onSelect: (next: FlowSelection) => void;
  rows: FlowRow[];
  filesInDiff: Set<string>;
  navRef: React.MutableRefObject<((delta: number) => void) | null>;
  coverage: React.ReactNode;
  traceError?: string;
}) {
  const flow = set.flows[selection.index] ?? null;
  const summaries = useMemo(() => set.flows.map((f) => summarise(f, set.hunks)), [set]);
  const lanes = useMemo(() => (flow ? lanesFor(flow, rows) : []), [flow, rows]);

  const [active, setActive] = useState<string[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const activeRef = useRef<string>("");
  const lit = useRef<HTMLElement | null>(null);

  // As the diff scrolls, the anchored line nearest the reading line lights,
  // and so do its steps.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * READING_LINE;
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const tr of document.querySelectorAll<HTMLElement>("tr[data-flow-steps]")) {
        const r = tr.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const d = Math.abs((r.top + r.bottom) / 2 - line);
        if (d < bestDist) {
          best = tr;
          bestDist = d;
        }
      }
      const keys = best?.dataset.flowSteps ?? "";
      if (keys === activeRef.current && best === lit.current) return;
      lit.current?.classList.remove("flow-inview");
      best?.classList.add("flow-inview");
      lit.current = best;
      activeRef.current = keys;
      setActive(keys ? keys.split(" ") : []);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // The diff renders its chips after this does; look once it has.
    const settle = setTimeout(update, 50);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearTimeout(settle);
      if (frame) cancelAnimationFrame(frame);
      lit.current?.classList.remove("flow-inview");
      lit.current = null;
      activeRef.current = "";
    };
  }, [rows]);

  const activeKeys = useMemo(() => new Set(active), [active]);

  // Keep the lit step in sight in the column, without moving the window: the
  // window is what's being read.
  useEffect(() => {
    const row = document.querySelector<HTMLElement>(".flow-row.inview");
    const scroller = row?.closest<HTMLElement>("[data-column-scroll]");
    if (!row || !scroller) return;
    const r = row.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (r.top < box.top + 80) scroller.scrollTop -= box.top + 80 - r.top;
    else if (r.bottom > box.bottom - 60) scroller.scrollTop += r.bottom - (box.bottom - 60);
  }, [active]);

  const goTo = useCallback(
    (row: FlowRow) => {
      const tr = anchorFor(row.key);
      if (tr) {
        setMissing(null);
        scrollToReadingLine(tr);
        return;
      }
      const where = `${row.step.file}:${row.step.line}`;
      if (filesInDiff.has(row.step.file)) {
        setMissing(null);
        revealLine(row.step.file, row.side, row.step.line);
        // The whole file loads, then the anchor exists.
        let tries = 0;
        const poll = setInterval(() => {
          const found = anchorFor(row.key);
          if (found || ++tries > 30) {
            clearInterval(poll);
            if (found) scrollToReadingLine(found);
          }
        }, 100);
      } else {
        setMissing(`${where} isn't in this diff`);
      }
    },
    [filesInDiff],
  );

  useEffect(() => {
    navRef.current = (delta) => {
      if (rows.length === 0) return;
      const at = rows.findIndex((r) => activeKeys.has(r.key));
      const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + delta))];
      if (next) goTo(next);
    };
    return () => {
      navRef.current = null;
    };
  }, [navRef, rows, activeKeys, goTo]);

  if (set.flows.length === 0) {
    return (
      <div className="space-y-3">
        <Notice>
          {set.hunks.length === 0
            ? "This change touches no app code, so there are no flows to trace."
            : "None of this change's app code is on a flow — it changes no behaviour a trigger reaches."}
        </Notice>
        {coverage}
        <Regenerate set={set} onRegenerate={api.regenerate} />
      </div>
    );
  }

  const summary = summaries[selection.index];
  const hereRow = rows.find((r) => activeKeys.has(r.key));
  const stepWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2 px-0.5">
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Flow {selection.index + 1} of {set.flows.length}
          {flow && <span className="normal-case"> · {flow.name}</span>}
        </h2>
        <button
          type="button"
          aria-label="Previous flow"
          disabled={selection.index <= 0}
          onClick={() => onSelect({ ...selection, index: selection.index - 1 })}
          className="rotate-180 rounded p-0.5 text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
        >
          <ChevronRightIcon size={14} />
        </button>
        <button
          type="button"
          aria-label="Next flow"
          disabled={selection.index >= set.flows.length - 1}
          onClick={() => onSelect({ ...selection, index: selection.index + 1 })}
          className="rounded p-0.5 text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)] disabled:opacity-30"
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>

      <div className="flex items-start gap-1.5">
        {set.flows.map((f, i) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={i === selection.index}
            className={`flow-pick ${summaries[i].changed ? "changed" : ""}`}
            title={`${f.name}${f.isNew ? " · new" : summaries[i].changed ? " · changed" : ""}`}
            onClick={() => onSelect({ ...selection, index: i })}
          >
            {i + 1}
          </button>
        ))}
        {flow && summary && (
          <div className="ml-1.5 min-w-0 flex-1">
            <div className="text-[14px] font-semibold leading-5">{flow.trigger}</div>
            <div className="text-[12px] leading-4 text-[var(--fg-muted)]">
              {flow.isNew ? (
                <span className="text-[var(--success)]">New flow · {stepWord(summary.afterSteps)}</span>
              ) : summary.changed ? (
                <>
                  {summary.removed > 0 && (
                    <span className="text-[var(--danger)]">{stepWord(summary.removed)} removed</span>
                  )}
                  {summary.removed > 0 && summary.added > 0 && ", "}
                  {summary.added > 0 && (
                    <span className="text-[var(--success)]">{summary.added} added</span>
                  )}
                  {" · "}
                  {stepWord(summary.beforeSteps ?? 0)} → {summary.afterSteps}
                </>
              ) : (
                <>Same steps · {stepWord(summary.afterSteps)}</>
              )}
            </div>
          </div>
        )}
        <span className="seg" role="group" aria-label="Show">
          {(["diff", "before", "after"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={selection.mode === mode}
              disabled={mode === "before" && flow?.before === null}
              onClick={() => onSelect({ ...selection, mode })}
            >
              {mode === "diff" ? "Diff" : mode === "before" ? "Before" : "After"}
            </button>
          ))}
        </span>
      </div>

      {flow && (
        <FlowSequence
          rows={rows}
          lanes={lanes}
          mode={selection.mode}
          activeKeys={activeKeys}
          onRowClick={goTo}
          footer={
            <>
              <span className="flow-here">
                <i />
                <span className="truncate">
                  {missing ??
                    (hereRow
                      ? `In view: ${hereRow.step.file.split("/").pop()}:${hereRow.step.line} · ${
                          hereRow.kind === "del" ? `was step ${hereRow.was}` : `step ${hereRow.now ?? hereRow.was}`
                        }`
                      : "No step of this flow in view")}
                </span>
              </span>
              <span className="flex-1" />
              <span className="shrink-0">Click a step to jump to its line</span>
            </>
          }
        />
      )}

      {traceError && <Notice tone="danger">Tracing that flow failed: {traceError}</Notice>}
      {coverage}
      <Regenerate set={set} onRegenerate={api.regenerate} />
    </section>
  );
}

function Regenerate({ set, onRegenerate }: { set: FlowSet; onRegenerate: () => void }) {
  return (
    <p className="flex items-center gap-2 px-0.5 text-[11px] text-[var(--fg-subtle)]">
      <span>
        Traced by Claude Code in {Math.round(set.durationMs / 1000)} s · $
        {set.costUsd.toFixed(2)}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onRegenerate}
        className="inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--accent)]"
        title="Trace this change's flows again"
      >
        <SyncIcon size={11} /> Regenerate
      </button>
    </p>
  );
}

function Generating({ startedAt, phase }: { startedAt: number | null; phase: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-4 py-6 text-center">
      <div className="flex items-center justify-center gap-2 text-[13px] font-medium">
        <Spinner /> Tracing flows…
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
        {phase} · {seconds} s. Claude Code reads the change and follows each user action it
        touches; it usually takes a minute or two.
      </p>
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger" | "attention";
}) {
  const border =
    tone === "danger"
      ? "border-[var(--danger)]"
      : tone === "attention"
        ? "border-[var(--attention)]"
        : "border-[var(--border)]";
  return (
    <div
      className={`flex items-start gap-2 rounded-md border ${border} bg-[var(--canvas)] px-3 py-3 text-[12px] text-[var(--fg-muted)]`}
    >
      {tone && (
        <AlertIcon
          size={13}
          className={`mt-0.5 shrink-0 ${tone === "danger" ? "text-[var(--danger)]" : "text-[var(--attention)]"}`}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}
