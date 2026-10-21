"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The tick on a note to your agent, and the small machinery that makes it
 * feel like one: you tick a note once you've seen your agent handle it.
 *
 * `pulse` counts transitions into the done state rather than tracking a
 * boolean, because restarting a CSS animation means remounting the element
 * that carries it. Keying on the count does that, and it also cancels the
 * previous pulse when you tick several notes in quick succession.
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts a timed pulse
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

export function sinceLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
