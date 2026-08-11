"use client";

import type { ReviewThread } from "@/lib/types";
import { stripMarkdown } from "@/lib/text";
import { TickCheck, useTickPulse } from "./Tick";

/**
 * The 48px column of ticks.
 *
 * It replaced a 300px rail that repeated, in text, everything the comment
 * pane beside it already showed. What a standing list is actually for is two
 * things — how far through you are, and jumping to any comment in one click —
 * and both survive at this width. The diff gets the rest.
 *
 * A square *selects*. Ticking is the button in the response panel, or `x`.
 * Selection has to stay the default here or the column stops being
 * navigation, and a 22px target can't safely mean two things.
 *
 * Top to bottom is oldest to newest — the order the reviewer left them. They
 * used to be grouped by file with a gap between groups, which only reads as
 * grouping while the order is spatial; against a chronological list the gaps
 * fire almost every row and mean nothing.
 */
export function TickSpine({
  threads,
  selectedId,
  onSelect,
}: {
  threads: ReviewThread[];
  selectedId: string | null;
  onSelect: (thread: ReviewThread) => void;
}) {
  const done = threads.filter((t) => t.response.done).length;

  return (
    <nav
      aria-label="Review comments"
      className="hidden w-12 shrink-0 flex-col items-center gap-1.5 self-start border-r lg:flex border-[var(--border)] bg-[var(--canvas-subtle)] px-0 pb-4 pt-3"
      style={{
        position: "sticky",
        top: "var(--header-height, 0px)",
        maxHeight: "calc(100vh - var(--header-height, 0px))",
      }}
    >
      <span className="mono pb-1 text-[10px] text-[var(--fg-muted)]">
        {done}/{threads.length}
      </span>

      {threads.map((thread) => (
        <SpineTick
          key={thread.id}
          thread={thread}
          selected={selectedId === thread.id}
          onSelect={() => onSelect(thread)}
        />
      ))}

      <span className="flex-1" />
      <span
        className="text-[10px] tracking-wide text-[var(--fg-subtle)]"
        style={{ writingMode: "vertical-rl" }}
      >
        {threads.length} {threads.length === 1 ? "comment" : "comments"} · j k x
      </span>
    </nav>
  );
}

function SpineTick({
  thread,
  selected,
  onSelect,
}: {
  thread: ReviewThread;
  selected: boolean;
  onSelect: () => void;
}) {
  const done = thread.response.done;
  // Ticking happens elsewhere, so this is where you *watch* it happen — the
  // square has to animate too, or the list you're working down stays inert.
  const pulse = useTickPulse(done);
  const first = thread.comments[0];
  const where = thread.path
    ? `${thread.path.split("/").pop()}${thread.line != null ? `:${thread.line}` : ""}`
    : "Review summary";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      aria-label={`${where} — ${done ? "handled" : "not handled"}`}
      title={`${where}\n${stripMarkdown(first?.body ?? "").slice(0, 120)}`}
      className={`tick-spring relative grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[5px] border ${
        done
          ? "border-[var(--handled)] bg-[var(--handled)] text-white"
          : "border-[var(--border)] bg-[var(--canvas)] text-transparent hover:border-[var(--fg-muted)]"
      }`}
      style={
        selected
          ? {
              boxShadow:
                "0 0 0 2px var(--accent-subtle), 0 0 0 3px var(--accent)",
            }
          : undefined
      }
    >
      <span key={pulse} className={pulse > 0 && done ? "tick-pop" : undefined}>
        <TickCheck pulse={pulse} />
      </span>
    </button>
  );
}

/**
 * Below `lg` the column becomes a strip under the header. The old 300px rail
 * simply vanished at that width with nothing in its place, which left the
 * checklist unreachable on a narrow window.
 */
export function TickStrip({
  threads,
  selectedId,
  onSelect,
}: {
  threads: ReviewThread[];
  selectedId: string | null;
  onSelect: (thread: ReviewThread) => void;
}) {
  const done = threads.filter((t) => t.response.done).length;

  return (
    <nav
      aria-label="Review comments"
      className="thin-scroll flex items-center gap-1.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2 lg:hidden"
      style={{ position: "sticky", top: "var(--header-height, 0px)", zIndex: 20 }}
    >
      <span className="mono shrink-0 pr-1 text-[10px] text-[var(--fg-muted)]">
        {done}/{threads.length}
      </span>
      {threads.map((thread) => (
        <SpineTick
          key={thread.id}
          thread={thread}
          selected={selectedId === thread.id}
          onSelect={() => onSelect(thread)}
        />
      ))}
    </nav>
  );
}
