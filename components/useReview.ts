"use client";

import { useCallback, useEffect, useState } from "react";

import { REVIEW_API } from "@/lib/constants";
import type { ApiError } from "@/lib/types";

export interface ReviewApi {
  /** Set while an agent is waiting on `backstory review` for this checkout */
  waiting: { id: string; createdAt: number } | null;
  /** Hand the notes over. Resolves false (with `error` set) if it didn't land. */
  send: (answer: string) => Promise<boolean>;
  /** Let the agent go on without notes. */
  dismiss: () => Promise<boolean>;
  error: string | null;
}

/**
 * Whether an agent is waiting for your review of this checkout.
 *
 * Re-asked whenever `tick` moves — the watch stream bumps it when a request
 * appears or goes away, and so does focusing the window — so there's no
 * polling of its own.
 */
export function useReview(root: string, tick: number): ReviewApi {
  const [waiting, setWaiting] = useState<ReviewApi["waiting"]>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${REVIEW_API}?${new URLSearchParams({ repo: root })}`, {
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((data: { waiting?: ReviewApi["waiting"] }) => {
        if (cancelled) return;
        setWaiting(data.waiting ?? null);
        // A fresh request wipes out the story of the last one.
        if (data.waiting) setError(null);
      })
      .catch(() => {
        // Server briefly away; the next tick asks again.
      });
    return () => {
      cancelled = true;
    };
  }, [root, tick]);

  const settle = useCallback(
    async (body: object) => {
      if (!waiting) return false;
      try {
        const response = await fetch(
          `${REVIEW_API}?${new URLSearchParams({ id: waiting.id })}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) {
          const data = (await response.json()) as ApiError;
          throw new Error(data.error);
        }
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        // Settled or gone, this request is over either way.
        setWaiting(null);
      }
    },
    [waiting],
  );

  const send = useCallback((answer: string) => settle({ answer }), [settle]);
  const dismiss = useCallback(() => settle({ dismiss: true }), [settle]);

  return { waiting, send, dismiss, error };
}
