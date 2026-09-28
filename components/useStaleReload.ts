"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Reload the window when the server behind it is a different build.
 *
 * The installed window outlives its server: rebuild, `brew upgrade`, or a
 * restart onto new code, and the open window keeps running the JavaScript it
 * loaded — calling APIs that have since changed shape. Next's own skew
 * protection only acts on navigations, and this window never navigates; it
 * only fetches.
 *
 * The first build seen is the one this page came from. Returns a check to run
 * whenever the server may have changed: a reconnect, or the window regaining
 * focus.
 */
export function useStaleReload(): () => void {
  const loadedFrom = useRef<string | null>(null);

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const { build } = (await response.json()) as { build?: string };
      if (!build) return;
      if (loadedFrom.current === null) loadedFrom.current = build;
      else if (build !== loadedFrom.current) window.location.reload();
    } catch {
      // Server away; the next reconnect checks again.
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return check;
}
