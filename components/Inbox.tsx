"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { InboxRepo, InboxResult, RemoteBranch } from "@/lib/inbox";
import { requestFetch } from "./fetchBranch";
import {
  AlertIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  GitCommitIcon,
  PullRequestIcon,
  SyncIcon,
} from "./icons";
import { InboxRow } from "./InboxRow";
import {
  ConnectGitHubLink,
  macApp,
  SETUP_SKIPPED_KEY,
  SetupChecklist,
  useInMacApp,
} from "./SetupChecklist";
import { Button, RelativeTime, Spinner } from "./ui";

/**
 * The home screen: every worktree you've got checked out, with the branches
 * that changed since you last opened them first.
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

  const latest = useRef(0);
  const load = useCallback(
    async (opts: { fresh?: boolean; quiet?: boolean } = {}) => {
      // Keep only the newest load's answer, so a poll that resolves after a
      // refresh, or after a root is removed, can't put back what it replaced.
      const n = ++latest.current;
      if (roots.length === 0) {
        setData(null);
        return;
      }
      if (!opts.quiet) setLoading(true);
      try {
        const params = new URLSearchParams();
        for (const root of roots) params.append("root", root);
        if (opts.fresh) params.set("fresh", "1");
        const response = await fetch(`/api/inbox?${params}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Couldn't scan your checkouts.");
        const result = (await response.json()) as InboxResult;
        if (n !== latest.current) return;
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
        if (n === latest.current)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts.quiet) setLoading(false);
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

  // Polls while main is read in any repo, as Story's drawings poll their
  // reads, so each repo's header follows its read until it ends.
  const reading = data?.repos.some((repo) => repo.reading) ?? false;
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void load({ quiet: true }), 4000);
    return () => clearInterval(timer);
  }, [reading, load]);

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

  const changed = (data?.rows ?? []).filter((row) => row.changed).length;
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
              {!data
                ? "Checking your worktrees…"
                : changed === 0
                  ? "Nothing new since you last looked"
                  : `${changed} ${changed === 1 ? "branch" : "branches"} changed since you last looked`}
            </h1>
            <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
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
                  {repo.reading && (
                    <span
                      className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--fg-muted)]"
                      role="status"
                    >
                      <Spinner className="!h-3 !w-3 shrink-0" />
                      <span className="truncate">
                        {repo.reading.phase}
                        {repo.reading.step &&
                          ` · step ${repo.reading.step.at} of ${repo.reading.step.of}`}
                      </span>
                    </span>
                  )}
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>
                {repo.reading?.big && (
                  <p className="mt-1 text-[12px] text-[var(--fg-subtle)]">
                    This is a big repo, the first read takes a while. You can
                    leave this open.
                  </p>
                )}

                {repo.unavailable && (
                  <p className="mt-2 flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                    <AlertIcon
                      size={13}
                      className="mt-0.5 shrink-0 text-[var(--attention)]"
                    />
                    <span>
                      {repo.unavailable} Everything below comes from git alone.
                      {repo.stale &&
                        " Pull requests shown are the last ones Backstory saw."}
                      {repo.connect && (
                        <>
                          {" "}
                          <ConnectGitHubLink />
                        </>
                      )}
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

                {repo.onGitHub.length > 0 && (
                  <OnGitHub repo={repo} onOpen={onOpen} />
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

/**
 * Teammates' open PRs and branches this clone has no local branch for.
 * Folded by default, so the count at the top stays about your own work.
 */
function OnGitHub({
  repo,
  onOpen,
}: {
  repo: InboxRepo;
  onOpen: (path: string, ref?: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{
    branch: string;
    message: string;
  } | null>(null);

  const open = async (remote: RemoteBranch) => {
    setBusy(remote.branch);
    setFailed(null);
    try {
      const result = await requestFetch(
        repo.root,
        remote.branch,
        remote.pr?.baseRefName ?? null,
      );
      onOpen(result.worktree ?? repo.root, remote.branch);
    } catch (err) {
      setFailed({
        branch: remote.branch,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="mt-1 group">
      <summary className="cursor-pointer list-none px-2 py-1.5 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]">
        <ChevronRightIcon
          size={11}
          className="mr-1 inline-block transition-transform group-open:rotate-90"
        />
        On GitHub · {repo.onGitHub.length}
      </summary>
      <div>
        {repo.onGitHub.map((remote) => (
          <button
            key={remote.branch}
            type="button"
            disabled={busy !== null}
            onClick={() => void open(remote)}
            className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md py-2 pl-2 pr-2 text-left hover:bg-[var(--canvas-subtle)] disabled:cursor-wait"
          >
            <span className="mt-[3px] grid place-items-center">
              {busy === remote.branch ? (
                <Spinner className="!h-3 !w-3" />
              ) : remote.pr ? (
                <PullRequestIcon size={12} className="text-[var(--fg-muted)]" />
              ) : (
                <GitCommitIcon size={12} className="text-[var(--fg-muted)]" />
              )}
            </span>
            <span className="min-w-0">
              {remote.pr ? (
                <>
                  <span className="block truncate text-[13px]">
                    <span className="text-[var(--fg-muted)]">
                      #{remote.pr.number}
                    </span>{" "}
                    {remote.pr.title}
                    {remote.pr.isDraft && (
                      <span className="text-[var(--fg-subtle)]"> · draft</span>
                    )}
                  </span>
                  <span className="mono mt-0.5 block truncate text-[11px] text-[var(--fg-subtle)]">
                    {remote.pr.author && `${remote.pr.author} · `}
                    {remote.branch}
                  </span>
                </>
              ) : (
                <span className="mono block truncate text-[13px] text-[var(--fg-muted)]">
                  {remote.branch}
                </span>
              )}
              {failed?.branch === remote.branch && (
                <span className="mt-1 block whitespace-pre-wrap text-[12px] text-[var(--danger)]">
                  {failed.message}
                </span>
              )}
            </span>
            <span className="whitespace-nowrap pl-4 text-[11px] text-[var(--fg-subtle)]">
              {remote.lastCommitAt && (
                <RelativeTime iso={remote.lastCommitAt} />
              )}
            </span>
          </button>
        ))}
      </div>
    </details>
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
