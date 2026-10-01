"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FlowsStatus } from "@/lib/flows/types";

/**
 * The flows for the view on screen. Generation is on demand: it starts the
 * first time the Flows tab is open on a view with nothing cached, and costs
 * nothing until then. A finished run arrives as a "flows" watch event
 * (`tick`); while one runs, a slow poll keeps its phase current.
 */
export function useFlows(repo: string, rev: string, active: boolean, tick: number) {
  const [status, setStatus] = useState<FlowsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef(`${repo}@${rev}`);
  viewRef.current = `${repo}@${rev}`;

  const request = useCallback(
    async (method: "GET" | "POST", extra: Record<string, string> = {}) => {
      const view = `${repo}@${rev}`;
      const params = new URLSearchParams({ repo, rev, ...extra });
      try {
        const response = await fetch(`/api/flows?${params}`, { method, cache: "no-store" });
        const data = (await response.json()) as FlowsStatus | { error: string };
        if (viewRef.current !== view) return null;
        if ("error" in data) {
          setError(data.error);
          return null;
        }
        setError(null);
        setStatus(data);
        return data;
      } catch (err) {
        if (viewRef.current === view) setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [repo, rev],
  );

  // A new view starts blank rather than showing the last one's flows.
  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [repo, rev]);

  useEffect(() => {
    if (!repo) return;
    void request("GET");
  }, [repo, rev, tick, request]);

  useEffect(() => {
    if (active && status?.status === "idle") void request("POST");
  }, [active, status, request]);

  const running = status?.status === "running" || (status?.status === "ready" && status.tracing.length > 0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  const regenerate = useCallback(() => void request("POST", { regenerate: "1" }), [request]);
  const retry = useCallback(() => void request("POST"), [request]);
  const trace = useCallback((hunk: string) => void request("POST", { hunk }), [request]);

  return { status, error, regenerate, retry, trace };
}

export type FlowsApi = ReturnType<typeof useFlows>;
