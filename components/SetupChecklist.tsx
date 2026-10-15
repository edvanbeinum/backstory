"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { GITHUB_LOGIN_API } from "@/lib/constants";
import type { GitHubLoginState } from "@/lib/githubLogin";
import type { SetupId, SetupRow } from "@/lib/setup";
import type { ApiError } from "@/lib/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { AlertIcon, CheckIcon } from "./icons";
import { Button, copyToClipboard, CopyButton, Spinner } from "./ui";

export const SETUP_SKIPPED_KEY = "backstory.setupSkipped";

const NAMES: Record<SetupId, string> = {
  git: "git",
  github: "GitHub",
  claude: "Claude Code",
  reviews: "Notes to your agent",
};

interface MacAppWindow {
  webkit?: {
    messageHandlers?: {
      backstory?: { postMessage: (message: string) => Promise<unknown> };
    };
  };
}

/**
 * The Mac app's message handler, absent in a browser. It takes "openRepo",
 * "setUpClaudeCode" and "removeClaudeCode", and its promise settles once the
 * panel or alerts are done.
 */
export const macApp = () =>
  (window as MacAppWindow).webkit?.messageHandlers?.backstory ?? null;
const noSubscription = () => () => {};

export function useInMacApp(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => macApp() !== null,
    () => false,
  );
}

/**
 * What Backstory needs on this machine, what each piece unlocks and the button
 * that fixes it. Checks again whenever the window comes back, so installing
 * or logging in to something in a terminal ticks its row on the way back.
 */
export function SetupChecklist({ onSkip }: { onSkip: () => void }) {
  const [rows, setRows] = useState<SetupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inMacApp = useInMacApp();

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
                {(row.state !== "ready" ||
                  (row.id === "reviews" && inMacApp)) && (
                  <div className="mt-1.5 text-[12px]">
                    <Fix row={row} inMacApp={inMacApp} onChanged={load} />
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

function Fix({
  row,
  inMacApp,
  onChanged,
}: {
  row: SetupRow;
  inMacApp: boolean;
  onChanged: () => Promise<void>;
}) {
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
      return (
        <ConnectGitHub
          ghInstalled={row.state !== "missing"}
          onConnected={onChanged}
        />
      );
    case "claude":
      return (
        <ClaudeCodeNotice
          reason={row.state === "logged-out" ? "logged-out" : "no-claude"}
        />
      );
    case "reviews":
      return inMacApp ? (
        <ClaudeCodeSetup ready={row.state === "ready"} onChanged={onChanged} />
      ) : (
        <span>Set it up from Backstory&apos;s Mac app.</span>
      );
  }
}

/** For a notice saying GitHub needs connecting: opens the setup checklist, where the sign-in lives. */
export function ConnectGitHubLink() {
  return (
    // A full load, not <Link>: the page reads `?setup=1` only on arrival and on popstate
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a
      href="/?setup=1"
      className="font-medium text-[var(--accent)] hover:underline"
    >
      Connect GitHub
    </a>
  );
}

const LOGIN_POLL_MS = 2000;

const LOGIN_ENDED: Partial<Record<GitHubLoginState["state"], string>> = {
  denied: "The code was denied on GitHub.",
  expired: "The code expired before it was approved.",
  offline: "Backstory couldn't reach GitHub.",
};

async function askLogin(method: "GET" | "POST"): Promise<GitHubLoginState> {
  const response = await fetch(GITHUB_LOGIN_API, {
    method,
    cache: "no-store",
  });
  if (!response.ok) {
    // Reads the server's own error: statusText is empty over HTTP/2, which
    // would leave the failure blank
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(
      body?.detail ?? body?.error ?? `Backstory answered ${response.status}.`,
    );
  }
  return (await response.json()) as GitHubLoginState;
}

/**
 * Connect GitHub: shows the code GitHub gives, with one button that copies it
 * and opens GitHub, then polls until it's approved or the sign-in ends.
 */
function ConnectGitHub({
  ghInstalled,
  onConnected,
}: {
  ghInstalled: boolean;
  onConnected: () => Promise<void>;
}) {
  const [login, setLogin] = useState<GitHubLoginState>({ state: "idle" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Picks up a sign-in already waiting, after the page reloads mid-way
    void askLogin("GET")
      .then((now) => {
        if (now.state === "waiting") setLogin(now);
      })
      .catch(() => {});
  }, []);

  const waiting = login.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void askLogin("GET")
        .then((now) => {
          setLogin(now);
          if (now.state === "connected") void onConnected();
        })
        .catch(() => {});
    }, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, onConnected]);

  const start = async () => {
    setBusy(true);
    try {
      setLogin(await askLogin("POST"));
    } catch (err) {
      setLogin({
        state: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    setBusy(false);
  };

  if (login.state === "waiting") {
    return (
      <div className="flex flex-col items-start gap-2">
        <span>Enter this code on GitHub:</span>
        <code className="mono text-[20px] font-semibold tracking-wider">
          {login.userCode}
        </code>
        <Button
          size="sm"
          variant="primary"
          href={login.verificationUri}
          onClick={() => void copyToClipboard(login.userCode)}
        >
          Copy code and open GitHub
        </Button>
        <span className="inline-flex items-center gap-1.5 text-[var(--fg-muted)]">
          <Spinner className="!h-3 !w-3" /> Waiting for you to approve it on
          GitHub…
        </span>
      </div>
    );
  }

  const ended =
    login.state === "failed" ? login.message : LOGIN_ENDED[login.state];
  return (
    <div className="flex flex-col items-start gap-1.5">
      {ended && (
        <span className="flex items-center gap-1.5 text-[var(--attention)]">
          <AlertIcon size={12} /> {ended}
        </span>
      )}
      <Button size="sm" variant="primary" disabled={busy} onClick={start}>
        {ended ? "Try again" : "Connect GitHub"}
      </Button>
      <span className="inline-flex flex-wrap items-center gap-2 text-[var(--fg-muted)]">
        <span>
          Or sign in with GitHub&apos;s <code className="mono">gh</code> tool:
        </span>
        {ghInstalled ? (
          <CopyButton value="gh auth login" label="Copy: gh auth login" />
        ) : (
          <Button size="sm" href="https://cli.github.com">
            Get GitHub&apos;s gh tool
          </Button>
        )}
      </span>
    </div>
  );
}

/** Asks the Mac app to add the Stop hook and `/backstory-review`, or take them out. */
function ClaudeCodeSetup({
  ready,
  onChanged,
}: {
  ready: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await macApp()?.postMessage(
        ready ? "removeClaudeCode" : "setUpClaudeCode",
      );
    } catch {
      // The app's own alerts said what went wrong; the refetch shows the rest.
    }
    await onChanged();
    setBusy(false);
  };
  return ready ? (
    <Button size="sm" variant="invisible" disabled={busy} onClick={run}>
      Remove…
    </Button>
  ) : (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>
        Add Backstory&apos;s Stop hook and{" "}
        <code className="mono">/backstory-review</code> to Claude Code.
      </span>
      <Button size="sm" disabled={busy} onClick={run}>
        Set Up
      </Button>
    </span>
  );
}
