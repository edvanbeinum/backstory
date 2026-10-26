"use client";

import { useEffect, useMemo, useState } from "react";

import { summarise, type FlowRow } from "@/lib/flows/rows";
import type { FlowSet } from "@/lib/flows/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { FlowCard, type StoryTarget } from "./FlowCard";
import type { ComponentInfo, DataField, StepBadge } from "./FlowSequence";
import { AlertIcon } from "./icons";
import { Button, Spinner } from "./ui";
import type { FlowsApi } from "./useFlows";

interface CardProps {
  repo: string;
  rev: string;
  onShowInFiles: (row: FlowRow) => void;
  /** Paths the diff shows, old and new; null until it loads */
  filesInDiff: Set<string> | null;
  target: StoryTarget | null;
  /** The target has been opened, so a later remount doesn't open it again */
  onTargetDone: (at: number) => void;
  /** j/k walk the topmost open card's steps */
  navRef: React.MutableRefObject<((delta: number) => boolean) | null>;
  components?: Map<string, ComponentInfo>;
  dataFields?: DataField[];
  /** "Worth a look" notes pinned on flows, by flow index */
  flowNotes?: Map<number, string[]>;
  /** Review comments on steps, by flow index */
  badges?: Map<number, Map<string, StepBadge[]>>;
  onBadge?: (threadId: string) => void;
}

/**
 * The story's flows: one card per flow once traced, or what stands in for
 * them until then. Nothing here changes tab, so the view stays on the story
 * through a run and when it finishes.
 */
export function Flows({
  api,
  fileCount,
  ...cards
}: CardProps & {
  api: FlowsApi;
  /** The change's files, for the untraced and uncommitted cards */
  fileCount: number | null;
}) {
  const { status, error } = api;

  if (error) {
    return (
      <Notice tone="danger">
        Couldn&apos;t load flows: {error}{" "}
        <button
          type="button"
          className="text-[var(--accent)]"
          onClick={api.reload}
        >
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
    // Story leaves out Flows on uncommitted work.
    return status.reason === "uncommitted" ? null : (
      <Notice tone="attention">
        <ClaudeCodeNotice reason={status.reason} needs="Flows need">
          <button
            type="button"
            className="text-[var(--accent)]"
            onClick={api.reload}
          >
            Look again
          </button>
        </ClaudeCodeNotice>
      </Notice>
    );
  }
  if (status.status === "idle") {
    return (
      <div className="story-card">
        <h3>This change hasn&apos;t been traced yet</h3>
        <p>
          Backstory reads the{" "}
          {fileCount !== null
            ? `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
            : "changed files"}{" "}
          and draws what each user action does, as flows across the map above.
        </p>
        <Button variant="primary" onClick={api.start}>
          Trace this change
        </Button>
      </div>
    );
  }
  if (status.status === "running") {
    return <Generating startedAt={status.startedAt} phase={status.phase} />;
  }
  if (status.status === "failed") {
    return (
      <Notice tone="danger">
        Tracing flows failed:{" "}
        <span className="mono text-[11px]">{status.error}</span>{" "}
        <button
          type="button"
          className="text-[var(--accent)]"
          onClick={api.retry}
        >
          Try again
        </button>
      </Notice>
    );
  }

  return (
    <ReadyFlows set={status.flows} runError={status.runError} {...cards} />
  );
}

function ReadyFlows({
  set,
  runError,
  target,
  navRef,
  flowNotes,
  badges,
  ...card
}: CardProps & {
  set: FlowSet;
  runError?: string;
}) {
  const summaries = useMemo(
    () => set.flows.map((f) => summarise(f, set.hunks)),
    [set],
  );

  // The first flow opens; the rest wait to be asked for. Kept through a
  // regenerate or a flow traced from a hunk, which are the same view.
  const view = `${set.base}..${set.head}`;
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    setOpen(new Set([0]));
  }
  const [seen, setSeen] = useState<number | null>(null);
  if (target && target.at !== seen) {
    setSeen(target.at);
    if (!open.has(target.flow)) setOpen(new Set([...open, target.flow]));
  }
  const top = set.flows.findIndex((_, i) => open.has(i));

  useEffect(() => {
    if (top === -1) navRef.current = null;
  }, [top, navRef]);

  if (set.flows.length === 0) {
    return (
      <Notice>
        {set.hunks.length === 0
          ? "This change touches no app code, so there are no flows to trace."
          : "None of this change's app code is on a flow — it changes no behaviour a trigger reaches."}
      </Notice>
    );
  }

  return (
    <div className="space-y-2.5">
      {set.flows.map((flow, i) => (
        <FlowCard
          key={flow.id}
          flow={flow}
          index={i}
          hunks={set.hunks}
          summary={summaries[i]}
          open={open.has(i)}
          onToggle={() => {
            const next = new Set(open);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            setOpen(next);
          }}
          target={target?.flow === i ? target : null}
          navRef={i === top ? navRef : null}
          notes={flowNotes?.get(i)}
          badges={badges?.get(i)}
          {...card}
        />
      ))}
      {runError && (
        <Notice tone="danger">
          The last run failed, so these are the flows from before it: {runError}
        </Notice>
      )}
    </div>
  );
}

function Generating({
  startedAt,
  phase,
}: {
  startedAt: number | null;
  phase: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = startedAt
    ? Math.max(0, Math.round((now - startedAt) / 1000))
    : 0;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-4 py-6 text-center">
      <div className="flex items-center justify-center gap-2 text-[13px] font-medium">
        <Spinner /> Tracing flows…
      </div>
      <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
        {phase} · {seconds} s. Claude Code reads the change and follows each
        user action it touches; it usually takes a minute or two.
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
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {children}
      </div>
    </div>
  );
}
