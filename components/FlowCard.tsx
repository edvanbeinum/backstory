"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  componentPath,
  flowRows,
  groupParticipants,
  type FlowMode,
  type FlowRow,
  type FlowSummary,
} from "@/lib/flows/rows";
import type { Flow, FlowHunk } from "@/lib/flows/types";
import {
  FlowSequence,
  type ComponentInfo,
  type DataField,
  type StepBadge,
} from "./FlowSequence";
import { StepCode } from "./StepCode";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

/** A flow and step for the story to open: a row key in the flow's diff mode. */
export interface StoryTarget {
  flow: number;
  row: string;
  /** When it was asked for, so asking twice opens it twice */
  at: number;
}

const NO_STEPS = new Set<string>();

/** Where in the window an opened step is brought to. */
const READING_LINE = 0.25;

function scrollToReadingLine(el: HTMLElement) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top:
      window.scrollY +
      el.getBoundingClientRect().top -
      window.innerHeight * READING_LINE,
    behavior: smooth ? "smooth" : "auto",
  });
}

const stepWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

/**
 * One flow in the story: its trigger, what the change did to it and the
 * components it crosses; opened, the sequence, where a step opens its code
 * beneath it. A collapsed card doesn't mount its sequence, whose width is
 * measured and would read as zero.
 */
export function FlowCard({
  flow,
  index,
  hunks,
  summary,
  open,
  onToggle,
  repo,
  rev,
  onShowInFiles,
  target,
  navRef,
  components,
  dataFields,
  notes = [],
  badges,
  onBadge,
}: {
  flow: Flow;
  index: number;
  hunks: FlowHunk[];
  summary: FlowSummary;
  open: boolean;
  onToggle: () => void;
  repo: string;
  rev: string;
  onShowInFiles: (row: FlowRow) => void;
  /** A step to open, asked for from elsewhere; this card is already open */
  target: StoryTarget | null;
  /** Set on the topmost open card only: j/k walk its steps */
  navRef: React.MutableRefObject<((delta: number) => boolean) | null> | null;
  components?: Map<string, ComponentInfo>;
  dataFields?: DataField[];
  /** "Worth a look" notes pinned on this flow */
  notes?: string[];
  /** Review comments on this flow's steps */
  badges?: Map<string, StepBadge[]>;
  onBadge?: (threadId: string) => void;
}) {
  const [mode, setMode] = useState<FlowMode>("diff");
  const shownMode = flow.before === null && mode === "before" ? "diff" : mode;
  const rows = useMemo(
    () => flowRows(flow, shownMode, hunks),
    [flow, shownMode, hunks],
  );
  const { participants, groups } = useMemo(
    () => groupParticipants(flow, rows),
    [flow, rows],
  );
  const path = useMemo(() => componentPath(flow, rows), [flow, rows]);

  /** Rows whose code is open beneath them */
  const [steps, setSteps] = useState<Set<string>>(NO_STEPS);
  const [stepsMode, setStepsMode] = useState<FlowMode>(shownMode);
  if (stepsMode !== shownMode) {
    setStepsMode(shownMode);
    setSteps(NO_STEPS);
  }
  const [scrollTo, setScrollTo] = useState<{ row: string; at: number } | null>(
    null,
  );
  const [seen, setSeen] = useState<number | null>(null);
  if (target && target.at !== seen) {
    setSeen(target.at);
    setMode("diff");
    setStepsMode("diff");
    setSteps(
      new Set([...(stepsMode === "diff" ? steps : NO_STEPS), target.row]),
    );
    setScrollTo({ row: target.row, at: target.at });
  }

  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollTo) return;
    const row = cardRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(scrollTo.row)}"]`,
    );
    if (row) scrollToReadingLine(row);
  }, [scrollTo]);

  const anyOpen = steps.size > 0;
  useEffect(() => {
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSteps(NO_STEPS);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyOpen]);

  const cursor = useRef<string | null>(null);
  useEffect(() => {
    cursor.current = null;
  }, [shownMode]);
  useEffect(() => {
    if (!navRef || !open) return;
    const nav = (delta: number) => {
      if (rows.length === 0) return false;
      const at = rows.findIndex((r) => r.key === cursor.current);
      const next =
        rows[
          Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + delta))
        ];
      cursor.current = next.key;
      setSteps(new Set([next.key]));
      setScrollTo({ row: next.key, at: Date.now() });
      return true;
    };
    navRef.current = nav;
    return () => {
      if (navRef.current === nav) navRef.current = null;
    };
  }, [navRef, open, rows]);

  const toggleStep = (row: FlowRow) => {
    cursor.current = row.key;
    setSteps((current) => {
      const next = new Set(current);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  };

  return (
    <div ref={cardRef} className={`flow-card ${open ? "open" : ""}`}>
      <div className="flow-card-head">
        <button
          type="button"
          className="flow-card-toggle"
          aria-expanded={open}
          onClick={onToggle}
          title={flow.name}
        >
          <span
            className={`flow-pick ${summary.changed ? "changed" : ""}`}
            aria-hidden="true"
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold leading-5">
              {flow.trigger}
            </span>
            <span className="block text-[12px] leading-4 text-[var(--fg-muted)]">
              {flow.isNew ? (
                <span className="text-[var(--success)]">
                  New flow · {stepWord(summary.afterSteps)}
                </span>
              ) : summary.changed ? (
                <>
                  {summary.removed > 0 && (
                    <span className="text-[var(--danger)]">
                      {stepWord(summary.removed)} removed
                    </span>
                  )}
                  {summary.removed > 0 && summary.added > 0 && ", "}
                  {summary.added > 0 && (
                    <span className="text-[var(--success)]">
                      {summary.added} added
                    </span>
                  )}
                  {" · "}
                  {stepWord(summary.beforeSteps ?? 0)} → {summary.afterSteps}
                </>
              ) : (
                <>Same steps · {stepWord(summary.afterSteps)}</>
              )}
            </span>
            {path.length > 0 && (
              <span
                className="flow-path"
                title="The map's components this flow passes through, in order"
              >
                {path.map((c, i) => (
                  <span key={c}>
                    {i > 0 && <span className="arrow">→</span>}
                    <span className="name">{c}</span>
                  </span>
                ))}
              </span>
            )}
            {notes.map((n) => (
              <span key={n} className="pinned-note mt-1">
                {n}
              </span>
            ))}
          </span>
          {open ? (
            <ChevronDownIcon size={14} className="chev" />
          ) : (
            <ChevronRightIcon size={14} className="chev" />
          )}
        </button>
        {open && (
          <span className="seg self-start" role="group" aria-label="Show">
            {(["diff", "before", "after"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={shownMode === m}
                disabled={m === "before" && flow.before === null}
                onClick={() => setMode(m)}
              >
                {m === "diff" ? "Diff" : m === "before" ? "Before" : "After"}
              </button>
            ))}
          </span>
        )}
      </div>

      {open && (
        <FlowSequence
          rows={rows}
          participants={participants}
          groups={groups}
          mode={shownMode}
          activeKeys={steps}
          onRowClick={toggleStep}
          open={steps}
          components={components}
          dataFields={dataFields}
          badges={badges}
          onBadge={onBadge}
          renderCode={(row) => (
            <StepCode
              repo={repo}
              rev={rev}
              path={row.step.file}
              side={row.side}
              line={row.step.line}
              onShowInFiles={() => onShowInFiles(row)}
            />
          )}
          footer={
            <>
              <span className="flow-here">
                <i />
                <span className="truncate">
                  {steps.size > 0
                    ? `${steps.size} ${steps.size === 1 ? "step's" : "steps'"} code open`
                    : "The code stays out of the way until you ask for it"}
                </span>
              </span>
              <span className="flex-1" />
              <span className="shrink-0">
                Click a step to open its code under it · Esc closes
              </span>
            </>
          }
        />
      )}
    </div>
  );
}
