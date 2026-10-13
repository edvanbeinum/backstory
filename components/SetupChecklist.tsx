"use client";

import { useCallback, useEffect, useState } from "react";

import type { SetupId, SetupRow } from "@/lib/setup";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { AlertIcon, CheckIcon } from "./icons";
import { Button, CopyButton, Spinner } from "./ui";

export const SETUP_SKIPPED_KEY = "backstory.setupSkipped";

const NAMES: Record<SetupId, string> = {
  git: "git",
  github: "GitHub",
  claude: "Claude Code",
  reviews: "Notes to your agent",
};

const BACKSTORY_COMMAND =
  "https://github.com/edvanbeinum/backstory#the-backstory-command";

/**
 * What Backstory needs on this machine, what each piece unlocks and the button
 * that fixes it. Checks again whenever the window comes back, so installing
 * or logging in to something in a terminal ticks its row on the way back.
 */
export function SetupChecklist({ onSkip }: { onSkip: () => void }) {
  const [rows, setRows] = useState<SetupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/setup", { cache: "no-store" });
      if (!response.ok) throw new Error(response.statusText);
      const data = (await response.json()) as { rows: SetupRow[] };
      setRows(data.rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--canvas)] text-left">
      <header className="border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold">Set up Backstory</h2>
          {!rows && !error && <Spinner className="!h-3 !w-3" />}
          <span className="flex-1" />
          <Button size="sm" variant="invisible" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
        <p className="text-[12px] text-[var(--fg-muted)]">
          Backstory only needs git. Each of the others adds something more.
        </p>
      </header>
      {error && (
        <p className="flex items-center gap-1.5 px-4 py-3 text-[12px] text-[var(--attention)]">
          <AlertIcon size={12} /> Couldn&apos;t check your setup: {error}
        </p>
      )}
      {rows && (
        <ul>
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-start gap-3 border-b border-[var(--border-muted)] px-4 py-3 last:border-b-0"
            >
              {row.state === "ready" ? (
                <span className="mt-0.5 shrink-0" title="Ready">
                  <CheckIcon size={16} className="text-[var(--success)]" />
                </span>
              ) : (
                <span
                  title="Not set up"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-[var(--fg-subtle)]"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold">
                    {NAMES[row.id]}
                  </span>
                  {row.id === "git" && (
                    <span className="text-[11px] text-[var(--fg-subtle)]">
                      needed
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-[var(--fg-muted)]">
                  {row.detail}
                </p>
                {row.state !== "ready" && (
                  <div className="mt-1.5 text-[12px]">
                    <Fix row={row} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Fix({ row }: { row: SetupRow }) {
  switch (row.id) {
    case "git":
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>
            Install Apple&apos;s developer tools. Paste this into Terminal:
          </span>
          <CopyButton
            value="xcode-select --install"
            label="Copy: xcode-select --install"
          />
        </span>
      );
    case "github":
      return row.state === "logged-out" ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>Sign in to GitHub. Paste this into Terminal:</span>
          <CopyButton value="gh auth login" label="Copy: gh auth login" />
        </span>
      ) : (
        <Button size="sm" href="https://cli.github.com">
          Get GitHub&apos;s gh tool
        </Button>
      );
    case "claude":
      return (
        <ClaudeCodeNotice
          reason={row.state === "logged-out" ? "logged-out" : "no-claude"}
        />
      );
    case "reviews":
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>A one-time setup in Terminal.</span>
          <Button size="sm" href={BACKSTORY_COMMAND}>
            Show me how
          </Button>
        </span>
      );
  }
}
