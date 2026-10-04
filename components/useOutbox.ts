"use client";

import { useCallback, useEffect, useState } from "react";

import { OUTBOX_API } from "@/lib/constants";
import type { OutboxRound, OutboxState } from "@/lib/outbox";
import type { ApiError } from "@/lib/types";

export interface OutboxApi {
  rounds: OutboxRound[];
  /** The session last seen stopping in this checkout — who Send aims at */
  lastSeen: OutboxState["lastSeen"];
  /** When each remembered session last stopped here */
  seen: Record<string, number>;
  /**
   * Hand a round over: to a waiting `differ review`, else into the queue —
   * or, with `via: "clipboard"`, record that it was copied. Resolves the
   * filed round, or null (with `error` set) if it didn't land.
   */
  send: (
    round: { noteIds: string[]; message: string; at: number; via?: "clipboard" },
  ) => Promise<OutboxRound | null>;
  /** Give a waiting round to whichever session stops here next */
  retarget: (id: string) => Promise<void>;
  /** Withdraw a waiting round; its notes go back to drafts */
  cancel: (id: string) => Promise<void>;
  error: string | null;
}

const EMPTY: OutboxState = { rounds: [], lastSeen: null, seen: {} };

/**
 * This checkout's sent rounds and how each one left. Re-read when `tick`
 * moves — the watch stream bumps it when a round is queued or collected — so
 * the window sees a delivery without polling. `onNotesChanged` is told when a
 * write here also moved notes between draft and sent.
 */
export function useOutbox(
  root: string,
  tick: number,
  onNotesChanged: () => void,
): OutboxApi {
  const [state, setState] = useState<OutboxState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${OUTBOX_API}?${new URLSearchParams({ repo: root })}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: OutboxState | null) => {
        if (!cancelled && data) setState(data);
      })
      .catch(() => {
        // Server briefly away; the next tick asks again.
      });
    return () => {
      cancelled = true;
    };
  }, [root, tick, version]);

  useEffect(() => {
    setState(EMPTY);
    setError(null);
  }, [root]);

  const call = useCallback(
    async <T,>(method: string, params: Record<string, string>, body?: object) => {
      try {
        const response = await fetch(
          `${OUTBOX_API}?${new URLSearchParams({ repo: root, ...params })}`,
          {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        const data = await response.json();
        if (!response.ok) throw new Error((data as ApiError).error);
        setError(null);
        return data as T;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setVersion((v) => v + 1);
      }
    },
    [root],
  );

  const send = useCallback<OutboxApi["send"]>(
    async (round) => {
      const data = await call<{ round: OutboxRound }>("POST", {}, round);
      onNotesChanged();
      return data?.round ?? null;
    },
    [call, onNotesChanged],
  );

  const retarget = useCallback(
    async (id: string) => {
      await call("PATCH", { id }, { forSession: null });
    },
    [call],
  );

  const cancel = useCallback(
    async (id: string) => {
      await call("DELETE", { id });
      onNotesChanged();
    },
    [call, onNotesChanged],
  );

  return {
    rounds: state.rounds,
    lastSeen: state.lastSeen,
    seen: state.seen,
    send,
    retarget,
    cancel,
    error,
  };
}
