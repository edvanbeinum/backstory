"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChangePane, openingChangeFor } from "@/components/ChangePane";
import { CommentPane } from "@/components/CommentPane";
import { AlertIcon, FileDiffIcon } from "@/components/icons";
import { Inbox } from "@/components/Inbox";
import { RepoBrowser } from "@/components/RepoBrowser";
import { PrTitle } from "@/components/PrTitle";
import { TickSpine, TickStrip } from "@/components/TickSpine";
import { RepoBar } from "@/components/RepoBar";
import {
  BRANCH_REV,
  INBOX_ROOTS_KEY,
  STORAGE_KEY,
  WORKING_REV,
} from "@/lib/constants";
import {
  loadRecents,
  removeFromList,
  saveRecents,
  touchList,
  type RecentRepo,
} from "@/lib/recents";
import {
  readUrlState,
  resolveComment,
  resolveRev,
  writeUrlState,
} from "@/lib/url";
import type {
  ApiError,
  CommitSummary,
  DiffResponse,
  ReviewThread,
  SessionResponse,
} from "@/lib/types";

const WORKING_COMMIT: CommitSummary = {
  sha: WORKING_REV,
  shortSha: WORKING_REV,
  subject: "Uncommitted changes",
  body: "",
  authorName: "",
  authorEmail: "",
  date: "",
  url: null,
  isMerge: false,
};

class ApiFetchError extends Error {
  constructor(
    message: string,
    readonly kind?: ApiError["kind"],
  ) {
    super(message);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    const err = data as ApiError;
    throw new ApiFetchError(
      err.detail ? `${err.error} (${err.detail})` : err.error,
      err.kind,
    );
  }
  return data as T;
}

export default function Page() {
  const [repoPath, setRepoPath] = useState("");
  /** A branch to review instead of the worktree's own. Null = the checkout. */
  const [ref, setRef] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  const [rev, setRev] = useState<string>(WORKING_REV);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  /** Set when a URL asked for a rev that isn't in the unpushed list. */
  const [revNotice, setRevNotice] = useState<string | null>(null);
  /** True while the watch stream is connected — shown as the live dot. */
  const [live, setLive] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  /** Previously-opened repos for the RepoBar dropdown. */
  const [recents, setRecents] = useState<RecentRepo[]>([]);

  /** Which rail is showing. Comments is the default; commits is self-review. */
  const [commentId, setCommentId] = useState<string | null>(null);
  /** Set when a URL asked for a comment that isn't in this PR. */
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  /** Bumped by watcher events; retriggers the working-tree diff fetch. */
  const [workingTick, setWorkingTick] = useState(0);
  const revRef = useRef(rev);
  const repoRef = useRef(repoPath);
  const refRef = useRef(ref);
  /** Discards out-of-order session responses from overlapping refreshes. */
  const sessionSeq = useRef(0);
  /**
   * Shas typed or pasted into the commit picker rather than chosen from the
   * list. The session only carries the branch's recent commits, so without
   * remembering these the next background refresh would decide the rev didn't
   * exist and bounce you off it.
   */
  const pickedRevs = useRef<string[]>([]);

  useEffect(() => {
    repoRef.current = repoPath;
  }, [repoPath]);
  useEffect(() => {
    refRef.current = ref;
  }, [ref]);

  // A bare `/` is the inbox. It used to reopen whatever you last had open,
  // which now hides the home screen behind a checkout you may be done with —
  // the key is still written, so the inbox can mark where you were, but it is
  // no longer an instruction to skip past it. A URL with `repo` still opens
  // exactly the view it describes.
  useEffect(() => {
    const fromUrl = readUrlState();
    const path = fromUrl.repo ?? "";

    setRepoPath(path);
    setRef(fromUrl.ref ?? null);
    if (fromUrl.rev) setRev(fromUrl.rev);
    if (fromUrl.comment) setCommentId(fromUrl.comment);
    if (fromUrl.repo) window.localStorage.setItem(STORAGE_KEY, fromUrl.repo);
    setRecents(loadRecents());
    setReady(true);
  }, []);

  // Every repo that loads successfully earns a spot in the dropdown, with
  // its branch as context; keyed on root+branch so background session
  // refreshes don't rewrite storage every few seconds.
  const sessionRoot = session?.repo.root;
  const sessionBranch = session?.repo.branch;
  useEffect(() => {
    if (!sessionRoot) return;
    setRecents((current) => {
      const next = touchList(
        current,
        { path: sessionRoot, branch: sessionBranch ?? null },
        Date.now(),
      );
      saveRecents(next);
      return next;
    });
  }, [sessionRoot, sessionBranch]);

  /**
   * Which repos the inbox scans.
   *
   * Not `recents` directly: that holds *worktree* paths capped at twelve, so
   * with twenty worktrees it fills up with one repo and quietly evicts the
   * other. The inbox reports the canonical root of everything it finds, and
   * those get written back here — twelve volatile worktree paths converge to
   * two stable repo roots after one load.
   */
  const [inboxRoots, setInboxRoots] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(INBOX_ROOTS_KEY);
      const stored = raw ? (JSON.parse(raw) as unknown) : null;
      const known = Array.isArray(stored)
        ? stored.filter((v): v is string => typeof v === "string")
        : [];
      const seeds = loadRecents().map((r) => r.path);
      setInboxRoots([...new Set([...known, ...seeds])]);
    } catch {
      setInboxRoots(loadRecents().map((r) => r.path));
    }
  }, []);

  const rememberRoot = useCallback((root: string) => {
    setInboxRoots((current) => {
      if (current.includes(root)) return current;
      const next = [...current, root];
      try {
        window.localStorage.setItem(INBOX_ROOTS_KEY, JSON.stringify(next));
      } catch {
        // Storage full or blocked — the inbox just rescans from recents.
      }
      return next;
    });
  }, []);

  const forgetRoot = useCallback((root: string) => {
    setInboxRoots((current) => {
      const next = current.filter((r) => r !== root);
      try {
        window.localStorage.setItem(INBOX_ROOTS_KEY, JSON.stringify(next));
      } catch {
        // As above.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (sessionRoot) rememberRoot(sessionRoot);
  }, [sessionRoot, rememberRoot]);

  const removeRecent = useCallback((path: string) => {
    setRecents((current) => {
      const next = removeFromList(current, path);
      saveRecents(next);
      return next;
    });
  }, []);

  // Keep the address bar in step with what's on screen. Entering or leaving a
  // workspace is a real navigation and gets a history entry; moving between
  // comments and commits inside one replaces, so Back doesn't have to walk
  // back through every keystroke.
  const wasInWorkspace = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const inWorkspace = Boolean(repoPath);
    writeUrlState(
      { repo: repoPath || null, ref, rev, mode: null, comment: commentId },
      { push: inWorkspace !== wasInWorkspace.current },
    );
    wasInWorkspace.current = inWorkspace;
  }, [ready, repoPath, ref, rev, commentId]);

  // Someone navigating with the back/forward buttons, or editing the URL by
  // hand, should land on the view they asked for.
  useEffect(() => {
    const onPopState = () => {
      const fromUrl = readUrlState();
      setRepoPath(fromUrl.repo ?? "");
      setRef(fromUrl.ref ?? null);
      setRev(fromUrl.rev ?? WORKING_REV);
      setCommentId(fromUrl.comment);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadSession = useCallback(
    async (
      path: string,
      opts: { background?: boolean; fresh?: boolean } = {},
    ) => {
      if (!path) {
        setSession(null);
        setSessionError(null);
        return;
      }

      const seq = ++sessionSeq.current;
      // Background refreshes (watcher, focus) skip the loading state — a
      // spinner flashing on every keystroke-burst would be worse than the
      // staleness it replaces.
      if (!opts.background) {
        setSessionLoading(true);
        setSessionError(null);
      }
      try {
        const data = await getJson<SessionResponse>(
          `/api/session?repo=${encodeURIComponent(path)}` +
            (refRef.current ? `&ref=${encodeURIComponent(refRef.current)}` : "") +
            (opts.fresh ? "&fresh=1" : ""),
        );
        if (seq !== sessionSeq.current) return; // superseded by a newer fetch
        setSession(data);
        setSessionError(null);

        let landedOn: string | null = null;
        setCommentId((current) => {
          const { commentId: next, notice } = resolveComment(
            current,
            data.github.threads,
          );
          setCommentNotice(notice);
          landedOn = next;
          return next;
        });

        setRev((current) => {
          // History counts: a URL can point at an already-pushed commit and
          // that's a perfectly good thing to view.
          const { rev: next, notice } = resolveRev(
            current,
            [...data.commits, ...data.history],
            data.working.hasChanges,
            data.branchDiff !== null,
            pickedRevs.current,
          );
          setRevNotice(notice);

          // Arriving with no rev asked for, on a comment that already names
          // the change answering it: show that change rather than an empty
          // "Uncommitted" pane. Only ever a fallback — an explicit rev, and
          // anything you pick later, wins.
          if (next === WORKING_REV && !data.working.hasChanges) {
            const thread = data.github.threads.find((t) => t.id === landedOn);
            const linked = thread?.response.commit;
            if (linked && !linked.missing) return linked.sha;
            if (data.branchDiff) return BRANCH_REV;
          }
          return next;
        });

      } catch (err) {
        if (seq !== sessionSeq.current) return;
        // A background failure keeps the last good view — the repo may just
        // be mid-rebase or briefly locked; the next event will retry.
        if (!opts.background) {
          setSession(null);
          setSessionError(err instanceof Error ? err.message : String(err));
          // A recent that no longer resolves is a deleted worktree — prune
          // it so the dropdown doesn't accumulate dead entries.
          if (
            err instanceof ApiFetchError &&
            (err.kind === "missing-path" || err.kind === "not-a-repo")
          ) {
            setRecents((current) => {
              const next = removeFromList(current, path);
              saveRecents(next);
              return next;
            });
          }
        }
      } finally {
        if (seq === sessionSeq.current && !opts.background) {
          setSessionLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    void loadSession(repoPath);
    // `ref` matters as much as the path: two branches of one stack are
    // reviewed from the same worktree, so switching between them changes
    // nothing else.
  }, [ready, repoPath, ref, loadSession]);

  // The `differ` CLI parks a repo path on the server when run from a
  // checkout; the installed app window can't be deep-linked, so it collects
  // the handoff here — on load and on every focus, which is exactly the
  // Cmd-Tab-into-the-window moment.
  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    const collect = async () => {
      try {
        const response = await fetch("/api/open", { cache: "no-store" });
        const data = (await response.json()) as { repo: string | null };
        if (cancelled) return;
        if (data.repo) {
          window.localStorage.setItem(STORAGE_KEY, data.repo);
          setRev(WORKING_REV);
          setRepoPath(data.repo);
        } else {
          // No handoff waiting — still a Cmd-Tab back in, so catch up on
          // anything that changed while the window was in the background.
          setWorkingTick((t) => t + 1);
          void loadSession(repoRef.current, { background: true });
        }
      } catch {
        // server briefly unavailable — the next focus will retry
      }
    };

    void collect();
    window.addEventListener("focus", collect);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", collect);
    };
  }, [ready, loadSession]);

  // Live updates: one SSE stream per repo. The server watches the repo's
  // filesystem and pushes a debounced event when git state or the working
  // tree changes; the window refetches instead of the user hitting reload.
  useEffect(() => {
    if (!ready || !repoPath) return;

    const source = new EventSource(
      `/api/watch?repo=${encodeURIComponent(repoPath)}`,
    );

    source.onopen = () => {
      setLive(true);
      // Reconnects (server restarted, laptop woke) mean missed events —
      // catch up once, bypassing the GitHub cache since time has passed.
      setWorkingTick((t) => t + 1);
      void loadSession(repoPath, { background: true, fresh: true });
    };

    source.onmessage = (event) => {
      let kinds: string[] = [];
      try {
        const parsed = JSON.parse(event.data) as { kinds?: string[] };
        if (parsed.kinds) kinds = parsed.kinds;
      } catch {
        return;
      }
      if (kinds.length === 0) return;

      setWorkingTick((t) => t + 1);
      void loadSession(repoPath, {
        background: true,
        // refs/remotes moved — a push or fetch landed, so GitHub's view
        // really may have changed; everything else is local-only.
        fresh: kinds.includes("remote"),
      });
    };

    // EventSource reconnects on its own; just reflect the state.
    source.onerror = () => setLive(false);

    return () => {
      source.close();
      setLive(false);
    };
  }, [ready, repoPath, loadSession]);

  const haveSession = session !== null;
  // A commit's diff is immutable, so watcher ticks only matter for the two
  // views that move — uncommitted work, and the branch diff (its HEAD end
  // advances with every commit); pinning the key otherwise keeps background
  // session refreshes from refetching a diff that cannot have changed.
  const workingDiffKey =
    rev === WORKING_REV || rev === BRANCH_REV ? workingTick : -1;

  useEffect(() => {
    revRef.current = rev;
    if (!repoPath || !haveSession) return;

    let cancelled = false;
    // Watcher-driven refetches of the working diff keep the old content on
    // screen until the new one arrives; only a rev switch shows the loader.
    setDiffLoading(true);
    setDiffError(null);

    getJson<DiffResponse>(
      `/api/diff?repo=${encodeURIComponent(repoPath)}&rev=${encodeURIComponent(rev)}`,
    )
      .then((data) => {
        if (cancelled) return;
        setDiff(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, rev, haveSession, workingDiffKey]);

  const commitForRev = useMemo((): CommitSummary | null => {
    if (rev === WORKING_REV) return WORKING_COMMIT;
    if (rev === BRANCH_REV) {
      const bd = session?.branchDiff;
      return {
        ...WORKING_COMMIT,
        sha: BRANCH_REV,
        shortSha: BRANCH_REV,
        subject: `All changes ${bd?.label ?? "vs base"}`,
        body: "",
      };
    }
    return (
      session?.commits.find((c) => c.sha === rev) ??
      session?.history.find((c) => c.sha === rev) ??
      null
    );
  }, [rev, session]);

  /** True when the selected commit is below the push boundary. */
  const revIsPushed = useMemo(
    () => Boolean(session?.history.some((c) => c.sha === rev)),
    [session, rev],
  );

  /**
   * Already ordered by file server-side, so the spine's grouping gaps, the
   * stepper and `j`/`k` all agree with the "first open comment" fallback.
   */
  const threads = useMemo(() => session?.github.threads ?? [], [session]);

  /** Thread ids whose file is touched by the diff currently on screen. */
  const anchoredIds = useMemo(() => {
    const paths = new Set(
      (diff?.files ?? []).flatMap((file) =>
        [file.newPath, file.oldPath].filter((p): p is string => Boolean(p)),
      ),
    );
    return new Set(
      threads.filter((t) => t.path && paths.has(t.path)).map((t) => t.id),
    );
  }, [diff, threads]);

  /**
   * How many threads a commit answers. A commit's linked threads (pinned, or
   * inferred from the file) are known for every commit without fetching any
   * diffs — that's what makes the rail navigable. For the commit on screen we
   * can also count open threads that land in its diff.
   */
  const linkedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const commit = thread.response.commit;
      if (!commit || commit.missing) continue;
      counts.set(commit.sha, (counts.get(commit.sha) ?? 0) + 1);
    }
    return counts;
  }, [threads]);

  const threadCountFor = useCallback(
    (candidate: string) => {
      const linked = linkedCounts.get(candidate) ?? 0;
      if (linked > 0) return linked;
      if (candidate !== rev) return 0;
      return threads.filter((t) => !t.isResolved && anchoredIds.has(t.id))
        .length;
    },
    [rev, threads, anchoredIds, linkedCounts],
  );

  /**
   * Clicking a thread takes you to the commit it's linked to, then scrolls
   * to the thread. With eight threads spread across several commits, hunting
   * for the right commit by hand was the confusing part.
   */
  const focusThread = useCallback(
    (thread: ReviewThread) => {
      setFocusedThreadId(thread.id);

      const commit = thread.response.commit;
      const linked = commit && !commit.missing ? commit.sha : null;
      const known =
        linked !== null &&
        (session?.commits.some((c) => c.sha === linked) ||
          session?.history.some((c) => c.sha === linked));
      if (known && linked !== rev) setRev(linked);

      // Two frames: one for the rev switch to render, one for the thread to
      // exist in the new diff. When the rev didn't change this is still fine.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const element = document.getElementById(`thread-${thread.id}`);
          if (!element) return;
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          element.classList.add("flash");
          setTimeout(() => element.classList.remove("flash"), 1500);
        }),
      );
    },
    [session, rev],
  );

  /**
   * Commits a thread can be pinned to: the unpushed ones first, then a slice
   * of pushed history. The right commit is often neither the guess nor the
   * selection — a fix can land in a different file from the one commented on
   * — so the picker has to offer the whole branch.
   */
  const pinCandidates = useMemo(
    () => [...(session?.commits ?? []), ...(session?.history ?? []).slice(0, 15)],
    [session],
  );

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === commentId) ?? null,
    [threads, commentId],
  );

  const commentIndex = useMemo(
    () => threads.findIndex((t) => t.id === commentId),
    [threads, commentId],
  );

  /**
   * Selecting a comment opens the change column on its linked commit if it
   * has one, or the whole branch diff if it doesn't — never a guess about
   * which commit answers it. Picking a commit leaves the comment alone, so
   * the two lists stay separate axes.
   */
  const selectComment = useCallback(
    (id: string) => {
      setCommentId(id);
      setFocusedThreadId(id);
      const thread = threads.find((t) => t.id === id) ?? null;
      const best = session ? openingChangeFor(thread, session) : null;
      if (best) setRev(best);
      window.scrollTo({ top: 0 });
    },
    [threads, session],
  );

  const stepComment = useCallback(
    (delta: number) => {
      if (commentIndex === -1) return;
      const next = threads[commentIndex + delta];
      if (next) selectComment(next.id);
    },
    [threads, commentIndex, selectComment],
  );

  /** Paths the working tree touches — drives the "uncommitted" answer state. */
  const workingPaths = useMemo(
    () => new Set(session?.working.changedPaths ?? []),
    [session],
  );

  /**
   * `owner/repo#42` — the response store's key. Sent with every write rather
   * than derived server-side, which used to cost a repo resolve and a GitHub
   * lookup on each one, and meant drafts were dropped whenever GitHub was
   * unreachable.
   */
  const responseKey = useMemo(() => {
    const repo = session?.repo;
    const pr = session?.github.pr;
    if (!repo?.owner || !repo.name || !pr) return null;
    return `${repo.owner}/${repo.name}#${pr.number}`;
  }, [session]);

  const writeResponse = useCallback(
    (
      threadId: string,
      patch: {
        done?: boolean;
        reply?: string | null;
        sha?: string | null;
        clear?: boolean;
      },
      opts: { keepalive?: boolean } = {},
    ) => {
      if (!responseKey) return Promise.resolve();
      // `repo` rides along only so the server can compute a patch-id when a
      // commit is linked; ticks and drafts need no subprocess at all.
      const params = new URLSearchParams({ key: responseKey });
      if (patch.sha) params.set("repo", repoPath);
      return fetch(`/api/responses?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, ...patch }),
        keepalive: opts.keepalive,
      }).catch(() => null);
    },
    [responseKey, repoPath],
  );

  /**
   * Save a thread's draft reply. Fire-and-forget: no session refresh, since
   * one would echo the text back into a box you're still typing in. The
   * saved copy is picked up on the next load, which is exactly when it's
   * needed — after a reload, a collapse, or switching commits.
   */
  const saveDraft = useCallback(
    (threadId: string, text: string | null) => {
      // keepalive so it survives the tab closing mid-save.
      void writeResponse(threadId, { reply: text }, { keepalive: true });
    },
    [writeResponse],
  );

  /**
   * The tick.
   *
   * Optimistic, and that isn't polish: a checkbox that waits for a round trip
   * doesn't feel like checking something off, and this is the interaction the
   * whole app is built around. The write is fire-and-forget; the next session
   * load reconciles it.
   */
  const toggleDone = useCallback(
    (threadId: string, done: boolean) => {
      setSession((current) => {
        if (!current) return current;
        return {
          ...current,
          github: {
            ...current.github,
            threads: current.github.threads.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    response: {
                      ...thread.response,
                      done,
                      doneAt: done
                        ? (thread.response.doneAt ?? Date.now())
                        : null,
                    },
                  }
                : thread,
            ),
          },
        };
      });
      void writeResponse(threadId, { done });
    },
    [writeResponse],
  );

  /**
   * Link the change on screen to a comment, or clear the link. Refreshes,
   * because the server computes the patch-id that lets the link survive a
   * rebase and the client has no way to know it.
   */
  const linkCommit = useCallback(
    async (threadId: string, sha: string | null) => {
      const response = await writeResponse(threadId, { sha });
      // A pasted sha can simply not exist. Saying so beats a click that looks
      // like it worked and leaves the row unchanged.
      if (response && !response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setLinkNotice(body?.error ?? "Couldn't link that commit.");
        return;
      }
      setLinkNotice(null);
      void loadSession(repoPath, { background: true });
    },
    [writeResponse, repoPath, loadSession],
  );

  /** The composer's commit picker speaks in shas. */
  const pinThread = useCallback(
    (threadId: string, sha: string | null) => void linkCommit(threadId, sha),
    [linkCommit],
  );

  /** Back to the home screen. Clearing the repo is what the inbox *is*. */
  const backToInbox = useCallback(() => {
    setRepoPath("");
    setRef(null);
    setSession(null);
    setSessionError(null);
    setCommentId(null);
    setRev(WORKING_REV);
  }, []);

  /**
   * Open a checkout, optionally reviewing a branch other than the one it has
   * checked out. The ref is always set, never left alone: typing a new path
   * with a stale branch still applied would review something that isn't
   * there.
   */
  const selectRepo = useCallback((path: string, branch?: string | null) => {
    const trimmed = path.trim();
    window.localStorage.setItem(STORAGE_KEY, trimmed);
    setRef(branch ?? null);
    setRepoPath(trimmed);
  }, []);

  // j/k through whichever rail is showing, the way you'd move through a list
  // in a TUI — comments when that's the rail, commits when it isn't.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "j" && event.key !== "k" && event.key !== "x") return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!session) return;

      // `x` ticks in place and deliberately does not advance: auto-advancing
      // steals the moment you just earned and makes a mis-tick awkward to
      // undo. `j` is right there.
      if (event.key === "x") {
        const thread = threads.find((t) => t.id === commentId);
        if (!thread) return;
        event.preventDefault();
        toggleDone(thread.id, !thread.response.done);
        return;
      }

      if (threads.length > 0) {
        const ids = threads.map((t) => t.id);
        const at = commentId ? ids.indexOf(commentId) : -1;
        if (at === -1) return;
        const step = event.key === "j" ? at + 1 : at - 1;
        if (step < 0 || step >= ids.length) return;

        event.preventDefault();
        selectComment(ids[step]);
        return;
      }

      const order = [
        ...(session.branchDiff ? [BRANCH_REV] : []),
        ...(session.working.hasChanges ? [WORKING_REV] : []),
        ...session.commits.map((c) => c.sha),
        // j keeps going straight across the push boundary into history
        ...session.history.map((c) => c.sha),
      ];
      const index = order.indexOf(rev);
      if (index === -1) return;

      const next = event.key === "j" ? index + 1 : index - 1;
      if (next < 0 || next >= order.length) return;

      event.preventDefault();
      setRev(order[next]);
      window.scrollTo({ top: 0 });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, rev, threads, commentId, toggleDone, selectComment]);

  return (
    <div className="min-h-screen">
      {repoPath && (
      <RepoBar
        repoPath={repoPath}
        onRepoPathChange={selectRepo}
        session={session}
        loading={sessionLoading || diffLoading}
        onRefresh={() => void loadSession(repoPath, { fresh: true })}
        live={live}
        recents={recents}
        onRemoveRecent={removeRecent}
        onBackToInbox={backToInbox}
      />
      )}

      {!repoPath ? (
        <>
          <Inbox
            roots={inboxRoots}
            onOpen={selectRepo}
            onBrowse={() => setBrowsing(true)}
            onForget={forgetRoot}
          />
          {browsing && (
            <RepoBrowser
              currentRepo={inboxRoots[0] ?? null}
              onPick={(path) => {
                setBrowsing(false);
                selectRepo(path);
              }}
              onClose={() => setBrowsing(false)}
            />
          )}
        </>
      ) : sessionError ? (
        <div className="mx-auto max-w-3xl p-6">
          <div className="flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--canvas)] p-4 text-[13px]">
            <AlertIcon className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <span>{sessionError}</span>
          </div>
        </div>
      ) : session ? (
        <div className="flex items-start">
          <TickSpine
            threads={threads}
            selectedId={commentId}
            onSelect={(thread) => selectComment(thread.id)}
          />

          <main className="min-w-0 flex-1 space-y-3 pb-16">
            {/* Below lg the spine can't sit beside the content, and the old
                rail simply vanished at this width — leaving the checklist
                unreachable. Same squares, laid out sideways. */}
            {threads.length > 0 && (
              <TickStrip
                threads={threads}
                selectedId={commentId}
                onSelect={(thread) => selectComment(thread.id)}
              />
            )}
            <div className="space-y-3 p-4 pt-3">
            {session.github.pr && <PrTitle pr={session.github.pr} />}

            {revNotice && (
              <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                <AlertIcon size={13} className="mt-0.5 shrink-0 text-[var(--attention)]" />
                <span className="flex-1">
                  <span className="mono">{revNotice}</span> isn&apos;t waiting
                  to be pushed any more — it may already be on GitHub. Showing
                  the latest instead.
                </span>
                <button
                  type="button"
                  onClick={() => setRevNotice(null)}
                  className="shrink-0 text-[var(--fg-muted)] hover:text-[var(--fg)]"
                >
                  Dismiss
                </button>
              </p>
            )}

            {session.github.unavailable && !session.github.pr && (
              <p className="rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2 text-[12px] text-[var(--fg-muted)]">
                {session.github.unavailable}
              </p>
            )}

            {linkNotice && (
              <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                <AlertIcon
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--attention)]"
                />
                <span className="flex-1">{linkNotice}</span>
                <button
                  type="button"
                  onClick={() => setLinkNotice(null)}
                  className="shrink-0 text-[var(--fg-muted)] hover:text-[var(--fg)]"
                >
                  Dismiss
                </button>
              </p>
            )}

            {commentNotice && (
              <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                <AlertIcon
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--attention)]"
                />
                <span className="flex-1">
                  That comment isn&apos;t on this pull request any more —
                  showing the first open one instead.
                </span>
                <button
                  type="button"
                  onClick={() => setCommentNotice(null)}
                  className="shrink-0 text-[var(--fg-muted)] hover:text-[var(--fg)]"
                >
                  Dismiss
                </button>
              </p>
            )}

            {/* Two columns, two independent selections: the comment you're
                working on stays put on the left while you browse changes on
                the right. Stacks below xl, where side-by-side would squeeze
                the diff too hard. */}
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
              <div
                className="thin-scroll min-w-0 xl:sticky xl:w-[440px] xl:shrink-0 xl:overflow-y-auto"
                style={{
                  top: "calc(var(--header-height, 0px) + 1rem)",
                  maxHeight: "calc(100vh - var(--header-height, 0px) - 2rem)",
                }}
              >
                <CommentPane
                  threads={threads}
                  thread={selectedThread}
                  index={commentIndex}
                  onStep={stepComment}
                  repo={session.repo}
                  pr={session.github.pr}
                  commit={commitForRev}
                  branch={session.repo.branch}
                  commitCandidates={pinCandidates}
                  onToggleDone={toggleDone}
                  onLinkCommit={linkCommit}
                  onDraftChange={saveDraft}
                />
              </div>

              <div className="min-w-0 flex-1">
                <ChangePane
                  session={session}
                  rev={rev}
                  onRevChange={(next) => {
                    // Remember anything that isn't in the offered list, so a
                    // pasted sha survives the next refresh.
                    if (
                      !session.commits.some((c) => c.sha === next) &&
                      !session.history.some((c) => c.sha === next)
                    ) {
                      pickedRevs.current = [
                        ...new Set([...pickedRevs.current, next]),
                      ];
                    }
                    setRev(next);
                  }}
                  commit={commitForRev}
                  diff={diff}
                  loading={diffLoading}
                  error={diffError}
                  threads={threads}
                  thread={selectedThread}
                  focusedThreadId={focusedThreadId}
                  onSelectThread={selectComment}
                  pushed={revIsPushed}
                />
              </div>
            </div>
            </div>
          </main>
        </div>
      ) : null}
    </div>
  );
}
