"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FlowsStatus } from "@/lib/flows/types";

/**
 * The flows for the view on screen. Tracing costs money and a minute, so it
 * starts only when asked ("Trace this change"); opening a commit to glance
 * at it costs nothing. Cached flows load as soon as the view opens. A
 * finished run arrives as a "flows" watch event (`tick`); while one runs, a
 * slow poll keeps its phase current.
 */
export function useFlows(repo: string, rev: string, tick: number | string) {
  // Kept with the view it answers, so a render just after a move never
  // shows the last view's status as this one's.
  const [answer, setAnswer] = useState<{ view: string; status: FlowsStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef(`${repo}@${rev}`);
  viewRef.current = `${repo}@${rev}`;
  /** Only the newest request's answer counts: an older one can land later. */
  const latest = useRef(0);

  const request = useCallback(
    async (method: "GET" | "POST", extra: Record<string, string> = {}) => {
      const view = `${repo}@${rev}`;
      const mine = ++latest.current;
      const stale = () => mine !== latest.current || viewRef.current !== view;
      const params = new URLSearchParams({ repo, rev, ...extra });
      try {
        const response = await fetch(`/api/flows?${params}`, { method, cache: "no-store" });
        const data = (await response.json()) as FlowsStatus | { error: string };
        // "All changes" refetches as HEAD moves; a slower earlier answer
        // would put the old head's flows back beside the new diff.
        if (stale()) return null;
        // A failed request is an HTTP error; a failed trace is a 200 whose
        // status says so, and must reach the panel as one.
        if (!response.ok) {
          setError((data as { error: string }).error);
          return null;
        }
        const status = data as FlowsStatus;
        setError(null);
        setAnswer({ view, status });
        return status;
      } catch (err) {
        if (!stale()) setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [repo, rev],
  );

  // A new view starts blank rather than showing the last one's flows.
  useEffect(() => {
    setAnswer(null);
    setError(null);
  }, [repo, rev]);

  useEffect(() => {
    if (!repo) return;
    void request("GET");
  }, [repo, rev, tick, request]);

  const status = answer?.view === `${repo}@${rev}` ? answer.status : null;
  const running = status?.status === "running" || (status?.status === "ready" && status.tracing.length > 0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  const regenerate = useCallback(() => void request("POST", { regenerate: "1" }), [request]);
  const start = useCallback(() => void request("POST"), [request]);
  /** After a failed trace: trace again, which is a paid run the user asked for. */
  const retry = start;
  /** After a failed load: only load again. Never a trace. */
  const reload = useCallback(() => void request("GET"), [request]);
  const trace = useCallback((hunk: string) => void request("POST", { hunk }), [request]);

  return { status, error, start, regenerate, retry, reload, trace };
}

export type FlowsApi = ReturnType<typeof useFlows>;
