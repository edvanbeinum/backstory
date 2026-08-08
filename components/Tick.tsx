"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The tick, and the small machinery that makes it feel like one.
 *
 * differ is a TODO tracker, so this is the moment it earns itself: nothing
 * else marks a comment handled, and the whole loop is read a comment, check
 * the change, tick it, move on. A control that just flips a boolean would
 * work and would be forgettable.
 *
 * `pulse` counts transitions into the done state rather than tracking a
 * boolean, because restarting a CSS animation means remounting the element
 * that carries it. Keying on the count does that, and it also gives the
 * cancel-your-predecessor behaviour for free when you hold `x` down a list.
 */
export function useTickPulse(done: boolean): number {
  const [pulse, setPulse] = useState(0);
  const was = useRef(done);

  useEffect(() => {
    // Only the untick→tick edge celebrates. Undo is quiet: reversing a
    // mis-tick shouldn't feel like a second event, let alone a punishment.
    if (done && !was.current) setPulse((n) => n + 1);
    was.current = done;
  }, [done]);

  return pulse;
}

/** The check, drawn on rather than snapped in. */
export function TickCheck({
  size = 13,
  pulse,
}: {
  size?: number;
  pulse: number;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path key={pulse} className="tick-draw" d="M3 8.5 6.2 11.7 13 4.9" />
    </svg>
  );
}

/**
 * The expanding ring. Rendered only while a pulse is live so it can't sit in
 * the DOM as an invisible overlay swallowing clicks.
 */
export function TickRing({ pulse }: { pulse: number }) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (pulse === 0) return;
    setLive(true);
    const timer = setTimeout(() => setLive(false), 400);
    return () => clearTimeout(timer);
  }, [pulse]);

  if (!live) return null;
  return (
    <span
      key={pulse}
      aria-hidden="true"
      className="tick-ring pointer-events-none absolute inset-0 rounded-[inherit] border-2 border-[var(--handled)]"
    />
  );
}

/**
 * The full-width control in the response panel: the primary way to tick, and
 * the most prominent thing in the column on purpose.
 */
export function TickButton({
  done,
  doneAt,
  onToggle,
}: {
  done: boolean;
  doneAt: number | null;
  onToggle: (next: boolean) => void;
}) {
  const pulse = useTickPulse(done);

  return (
    <button
      type="button"
      onClick={() => onToggle(!done)}
      aria-pressed={done}
      className={`tick-spring relative flex w-full items-center justify-center gap-2 rounded-md px-3 py-2.5 text-[13px] font-semibold ${
        done
          ? "border border-[var(--handled)] bg-[var(--handled)] text-white"
          : "border border-[var(--border)] bg-[var(--canvas)] text-[var(--fg)] hover:bg-[var(--canvas-subtle)]"
      }`}
    >
      <span key={pulse} className={pulse > 0 && done ? "tick-pop" : undefined}>
        <TickCheck size={15} pulse={pulse} />
      </span>
      <span className="flex-1 text-left">
        {done ? "Handled" : "Mark as handled"}
      </span>
      {done && doneAt ? (
        <span className="text-[11px] font-normal opacity-75">
          {sinceLabel(doneAt)}
        </span>
      ) : null}
      <span
        className="mono rounded border px-[5px] text-[11px] font-normal opacity-75"
        style={{ borderColor: "currentColor" }}
      >
        x
      </span>
      <TickRing pulse={done ? pulse : 0} />
    </button>
  );
}

function sinceLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
