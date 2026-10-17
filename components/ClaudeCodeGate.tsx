"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderStatus } from "@/lib/ai/provider";
import { AI_API, DRAWS_WITH_CLAUDE_CODE } from "@/lib/constants";
import type { ApiError } from "@/lib/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { AlertIcon } from "./icons";
import { Button } from "./ui";

type Check = { status: ProviderStatus } | { error: string };

/**
 * Shows its children only once Claude Code is installed and signed in, and
 * otherwise a card with the fix. Checks again whenever the window comes back,
 * so signing in in a terminal opens Backstory on the way back. A first check
 * that fails blocks too, with Try again: Backstory can't draw anything without
 * Claude Code, so it never guesses that it's there.
 */
export function ClaudeCodeGate({ children }: { children: React.ReactNode }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [opened, setOpened] = useState(false);
  // Skips a check while one is running: coming back to the window fires both
  // focus and visibilitychange, and each check runs `claude` twice.
  const checking = useRef(false);

  const load = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const response = await fetch(AI_API, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        { status: ProviderStatus } | ApiError | null;
      if (!response.ok || !body || !("status" in body))
        throw new Error(
          (body && "error" in body && (body.detail ?? body.error)) ||
            `Backstory answered ${response.status}.`,
        );
      setCheck({ status: body.status });
      if (body.status === "ready") setOpened(true);
    } catch (err) {
      // Keeps an open review open when a later check fails, as it does while
      // the server restarts: unmounting it would lose unsaved notes.
      const error = err instanceof Error ? err.message : String(err);
      setCheck((was) =>
        was && "status" in was && was.status === "ready" ? was : { error },
      );
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches on mount
    void load();
    const onFocus = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Renders nothing until the first answer, so a returning user never sees
  // the card flash.
  if (!check) return null;
  const ready = "status" in check && check.status === "ready";
  // Hides an open review behind the card rather than unmounting it, so a
  // check that answers missing mid-review, as one does while Claude Code
  // updates itself, keeps unsaved notes and drafts.
  if (opened)
    return (
      <>
        <div hidden={!ready}>{children}</div>
        {!ready && card(check, load)}
      </>
    );
  return card(check, load);
}

function card(check: Check, load: () => Promise<void>) {
  return (
    <div className="mx-auto max-w-2xl p-6 pt-16">
      {"error" in check ? (
        <div className="story-card">
          <h3>Couldn&apos;t check for Claude Code</h3>
          <p className="flex items-center justify-center gap-1.5 text-[var(--attention)]">
            <AlertIcon size={12} /> {check.error}
          </p>
          <Button variant="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="story-card">
          <h3>Backstory draws your code with Claude Code</h3>
          <p>{DRAWS_WITH_CLAUDE_CODE}</p>
          <ClaudeCodeNotice
            reason={check.status === "missing" ? "no-claude" : "logged-out"}
          />
        </div>
      )}
    </div>
  );
}
