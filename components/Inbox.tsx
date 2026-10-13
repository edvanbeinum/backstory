"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { InboxResult } from "@/lib/inbox";
import {
  AlertIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  SyncIcon,
} from "./icons";
import { InboxRow } from "./InboxRow";
import {
  macApp,
  SETUP_SKIPPED_KEY,
  SetupChecklist,
  useInMacApp,
} from "./SetupChecklist";
import { Button, Spinner } from "./ui";

/**
 * The home screen: every worktree you've got checked out, and how much of each
 * one's review is still waiting on you.
 *
 * Before this, Backstory could only ever show one branch, and getting to it
 * meant typing or browsing a path. With twenty worktrees across two repos, "what's
 * outstanding everywhere I'm working" had no answer at all — which is a
 * strange gap in something that's meant to be a TODO tracker.
 */
export function Inbox({
  roots,
  onOpen,
  onAdd,
  onBrowse,
  onForget,
  setupAsked,
  onSetupDone,
}: {
  /** Repos to scan — the ones you've opened before. */
  roots: string[];
  onOpen: (path: string, ref?: string | null) => void;
  /** Put a repo on the list without opening it. */
  onAdd: (root: string) => void;
  onBrowse: () => void;
  /** Drop remembered paths that no longer resolve — one, or the lot. */
  onForget: (paths: string[]) => void;
  /** `?setup=1`: show the setup checklist, whatever the roots and Skip for now say */
  setupAsked: boolean;
  onSetupDone: () => void;
}) {
  /** Null until localStorage is read, so a returning user never sees the checklist flash */
  const [skipped, setSkipped] = useState<boolean | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setSkipped(window.localStorage.getItem(SETUP_SKIPPED_KEY) !== null);
  }, []);
  const skipSetup = useCallback(() => {
    try {
      window.localStorage.setItem(SETUP_SKIPPED_KEY, "1");
    } catch {
      // Storage blocked: the checklist comes back next time, which is harmless.
    }
    setSkipped(true);
    onSetupDone();
  }, [onSetupDone]);
  const [data, setData] = useState<InboxResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** How many dead paths were dropped this load — said once, quietly. */
  const [forgot, setForgot] = useState(0);
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * Check a typed path before remembering it. Skipping this would be worse
   * than it sounds: a path that doesn't resolve is now dropped on sight, so
   * adding a bad one would look like nothing happened at all.
   */
  const addRepo = useCallback(
    async (raw: string) => {
      const wanted = raw.trim();
      if (!wanted) return;
      setChecking(true);
      setAddError(null);
      try {
        const response = await fetch(
          `/api/inbox?root=${encodeURIComponent(wanted)}`,
          { cache: "no-store" },
        );
        const found = (await response.json()) as InboxResult;
        if (!response.ok || found.repos.length === 0) {
          // The server's wording is for a path that used to resolve; when
          // you've just typed one, "any more" is nonsense.
          setAddError(`Not a git checkout: ${wanted}`);
          return;
        }
        // Its canonical root, so a worktree adds the repo it belongs to.
        onAdd(found.repos[0].root);
        setAdding("");
      } catch {
        setAddError("Couldn't reach Backstory.");
      } finally {
        setChecking(false);
      }
    },
    [onAdd],
  );

  const key = useMemo(() => [...roots].sort().join("\0"), [roots]);

  const load = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      if (roots.length === 0) {
        setData(null);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams();
        for (const root of roots) params.append("root", root);
        if (opts.fresh) params.set("fresh", "1");
        const response = await fetch(`/api/inbox?${params}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Couldn't scan your checkouts.");
        const result = (await response.json()) as InboxResult;
        setData(result);
        setError(null);

        // A path that no longer resolves is a worktree you deleted. There's
        // nothing Backstory can do with one and nothing it can tell you about
        // it, so it stops remembering it rather than listing it.
        //
        // Unless *nothing* resolved: every path failing at once is the
        // signature of git being broken, not of you deleting everything, and
        // forgetting the lot on that basis would be unrecoverable.
        if (result.unresolved.length > 0 && result.repos.length > 0) {
          setForgot(result.unresolved.length);
          onForget(result.unresolved.map((entry) => entry.path));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, onForget],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches when its key changes
    void load();
  }, [load]);

  // Refresh on focus, but never `fresh`: the installed window fires focus
  // constantly, and forcing past the cache there would make the home screen a
  // GitHub poller.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const rowsByRepo = useMemo(() => {
    if (!data) return [];
    return data.repos.map((repo) => {
      const mine = data.rows.filter((row) => row.repo === repo.commonDir);
      return {
        repo,
        rows: mine.filter((row) => !row.archived),
        archived: mine.filter((row) => row.archived),
      };
    });
  }, [data]);

  // A merged PR can't need a response, so it doesn't count. Counting them
  // made this read three times higher than the work actually waiting.
  const live = useMemo(
    () => (data?.rows ?? []).filter((row) => !row.archived),
    [data],
  );
  const outstanding = useMemo(
    () =>
      live.reduce(
        (total, row) =>
          total + (row.progress ? row.progress.total - row.progress.done : 0),
        0,
      ),
    [live],
  );
  const branchesWaiting = live.filter(
    (row) => row.progress && row.progress.done < row.progress.total,
  ).length;
  // A row is a branch now, not always a worktree — a stacked PR is reviewable
  // without one, so the two counts have to be said separately.
  const checkedOut = (data?.rows ?? []).filter((row) => row.worktree).length;
  const branchesOnly = (data?.rows ?? []).length - checkedOut;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--canvas-subtle)]">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[15px] font-semibold">
            <FileDiffIcon size={15} className="text-[var(--fg-muted)]" />
            Backstory
          </span>
          <span className="flex-1" />
          {loading && <Spinner />}
          <button
            type="button"
            onClick={onBrowse}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] font-medium hover:bg-[var(--canvas-subtle)]"
          >
            <FolderIcon size={13} /> Browse…
          </button>
          <button
            type="button"
            onClick={() => void load({ fresh: true })}
            title="Check GitHub again"
            className="rounded-md p-1 text-[var(--fg-muted)] hover:bg-[var(--canvas)] hover:text-[var(--fg)]"
          >
            <SyncIcon size={14} />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-6">
        {roots.length === 0 ? (
          <NoCheckouts
            onBrowse={onBrowse}
            onAdd={(path) => void addRepo(path)}
            error={addError}
            checking={checking}
            checklist={
              (setupAsked || skipped === false) && (
                <SetupChecklist onSkip={skipSetup} />
              )
            }
          />
        ) : (
          <>
            {setupAsked && (
              <div className="mb-8">
                <SetupChecklist onSkip={skipSetup} />
              </div>
            )}
            <h1 className="text-[20px] font-semibold">
              {outstanding === 0
                ? data
                  ? "Nothing needs a response"
                  : "Checking your worktrees…"
                : `${outstanding} ${outstanding === 1 ? "comment needs" : "comments need"} a response`}
            </h1>
            <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
              {branchesWaiting > 0 && (
                <>
                  across {branchesWaiting}{" "}
                  {branchesWaiting === 1 ? "branch" : "branches"} ·{" "}
                </>
              )}
              {checkedOut} {checkedOut === 1 ? "worktree" : "worktrees"} checked
              out
              {branchesOnly > 0 && `, ${branchesOnly} more branches with a PR`}
            </p>

            {forgot > 0 && (
              <p className="mt-2 text-[12px] text-[var(--fg-subtle)]">
                Forgot {forgot} {forgot === 1 ? "checkout" : "checkouts"} that
                no longer {forgot === 1 ? "exists" : "exist"}.
              </p>
            )}

            {error && (
              <p className="mt-4 flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--canvas)] px-3 py-2 text-[13px]">
                <AlertIcon size={13} className="mt-0.5 text-[var(--danger)]" />
                {error}
              </p>
            )}

            {rowsByRepo.map(({ repo, rows, archived }) => (
              <section key={repo.commonDir} className="mt-6">
                <div className="flex items-center gap-3">
                  <h2 className="mono text-[11px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
                    {repo.label}
                  </h2>
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>

                {repo.unavailable && (
                  <p className="mt-2 flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                    <AlertIcon
                      size={13}
                      className="mt-0.5 shrink-0 text-[var(--attention)]"
                    />
                    <span>
                      {repo.unavailable} Everything below comes from git alone.
                      {repo.stale &&
                        " Counts shown are the last ones Backstory saw."}
                    </span>
                  </p>
                )}

                <div className="mt-1">
                  {rows.map((row) => (
                    <InboxRow
                      key={row.id}
                      row={row}
                      onOpen={() => onOpen(row.reviewPath, row.branch)}
                    />
                  ))}
                </div>

                {archived.length > 0 && (
                  // Folded away rather than dropped: several of these are
                  // worktrees still on disk, and this is the only screen that
                  // says what you have checked out.
                  <details className="mt-1 group">
                    <summary className="cursor-pointer list-none px-2 py-1.5 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
                      <ChevronRightIcon
                        size={11}
                        className="mr-1 inline-block transition-transform group-open:rotate-90"
                      />
                      Done · {archived.length} merged or closed
                    </summary>
                    <div className="opacity-60">
                      {archived.map((row) => (
                        <InboxRow
                          key={row.id}
                          row={row}
                          onOpen={() => onOpen(row.reviewPath, row.branch)}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </section>
            ))}

            <form
              className="mt-8 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void addRepo(adding);
              }}
            >
              <span className="text-[12px] text-[var(--fg-muted)]">
                Add a repo
              </span>
              <input
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
                placeholder="/Users/you/code/another-repo"
                spellCheck={false}
                aria-label="Path to a repository"
                className="mono min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
              />
              <button
                type="submit"
                disabled={checking || adding.trim() === ""}
                className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent-subtle)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {checking ? "Checking…" : "Add"}
              </button>
              <button
                type="button"
                onClick={onBrowse}
                className="text-[12px] text-[var(--accent)] hover:underline"
              >
                or browse…
              </button>
              {addError && (
                <span className="w-full text-[12px] text-[var(--attention)]">
                  {addError}
                </span>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function NoCheckouts({
  onBrowse,
  onAdd,
  error,
  checking,
  checklist,
}: {
  onBrowse: () => void;
  onAdd: (path: string) => void;
  error: string | null;
  checking: boolean;
  checklist: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const inMacApp = useInMacApp();

  return (
    <div className="mx-auto max-w-xl py-12 text-center">
      {checklist && <div className="mb-10">{checklist}</div>}
      <FolderIcon size={28} className="mx-auto text-[var(--fg-subtle)]" />
      <h1 className="mt-3 text-[16px] font-semibold">No checkouts yet</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        Point Backstory at a repo and it will list every worktree beside it,
        with the branch each one holds.
      </p>

      <div className="mt-5 flex items-center justify-center gap-2">
        {inMacApp && (
          <Button
            variant="primary"
            onClick={() => void macApp()?.postMessage("openRepo")}
          >
            Open Repo…
          </Button>
        )}
        <Button variant={inMacApp ? "default" : "primary"} onClick={onBrowse}>
          Browse…
        </Button>
      </div>
      {inMacApp && (
        <p className="mt-2 text-[12px] text-[var(--fg-muted)]">
          or drop a repo&apos;s folder on this window
        </p>
      )}

      <details className="mt-6 text-[12px]">
        <summary className="cursor-pointer text-[var(--fg-muted)] hover:text-[var(--fg)]">
          Type a path
        </summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onAdd(value.trim());
          }}
          className="mx-auto mt-2 flex max-w-md items-center gap-2"
        >
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="/Users/you/code/your-repo"
            spellCheck={false}
            aria-label="Path to a repository"
            className="mono min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <Button size="sm" type="submit" disabled={checking}>
            {checking ? "Checking…" : "Add"}
          </Button>
        </form>
        {error && (
          <p className="mt-2 text-[12px] text-[var(--attention)]">{error}</p>
        )}
      </details>
    </div>
  );
}
