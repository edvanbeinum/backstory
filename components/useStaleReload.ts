"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Reload the window when the server behind it is a different build.
 *
 * The window outlives its server: a rebuild, a new copy of the app, or a
 * restart onto new code, and the open window keeps running the JavaScript it
 * loaded — calling APIs that have since changed shape. Next's own skew
 * protection only acts on navigations, and this window never navigates; it
 * only fetches.
 *
 * The first build seen is the one this page came from. Returns a check to run
 * whenever the server may have changed: a reconnect, or the window regaining
 * focus. It resolves true when it has started a reload, so the caller can
 * leave anything it would have taken from the server to the reloaded page.
 */
export function useStaleReload(): () => Promise<boolean> {
  const loadedFrom = useRef<string | null>(null);

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const { build } = (await response.json()) as { build?: string };
      if (!build) return false;
      if (loadedFrom.current === null) loadedFrom.current = build;
      else if (build !== loadedFrom.current) {
        window.location.reload();
        return true;
      }
    } catch {
      // Server away; the next reconnect checks again.
    }
    return false;
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return check;
}
