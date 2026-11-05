"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useStaleReload } from "@/components/useStaleReload";
import type { OpenView } from "@/components/ViewContext";
import { WORKING_REV } from "@/lib/constants";
import type { ApiError, SessionResponse } from "@/lib/types";
import { resolveComment, resolveRev } from "@/lib/url";

export interface Ticks {
  /** Bumped by watcher events; reads uncommitted work's diff again. */
  working: number;
  /**
   * Bumped when an agent starts or stops waiting for a review, or a sent
   * round is queued, collected or withdrawn.
   */
  review: number;
  /** Bumped when a flow run finishes. */
  flows: number;
  /** Bumped when a model or data model draft is written, so both are read again */
  model: number;
}

const AGENT_KINDS = ["review", "outbox"];

/**
 * What a watch event's kinds ask for: the ticks to bump, and a background
 * reload, fresh from GitHub when refs/remotes moved. A review request, a
 * queued round or a finished flow run changes nothing on disk, so they
 * reload nothing.
 */
function onWatch(kinds: string[]): {
  bump: (keyof Ticks)[];
  reload: { fresh: boolean } | null;
} {
  const bump: (keyof Ticks)[] = [];
  if (kinds.some((kind) => AGENT_KINDS.includes(kind))) bump.push("review");
  if (kinds.includes("flows")) bump.push("flows");
  if (kinds.every((kind) => kind === "flows" || AGENT_KINDS.includes(kind)))
    return { bump, reload: null };
  bump.push("working");
  return { bump, reload: { fresh: kinds.includes("remote") } };
}

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

/**
 * The open session: the repo's commits, working tree and PR, loaded for the
 * repo and branch in the address bar and kept current by the watch stream and
 * a catch-up on focus.
 */
export function useSession({
  repo,
  ref,
  ready,
  setRev,
  setComment,
  onOpened,
  onGone,
}: {
  repo: string;
  ref: string | null;
  ready: boolean;
  setRev: (update: (current: string) => string) => void;
  setComment: (update: (current: string | null) => string | null) => void;
  /** Called once each time a load shows another root or branch. */
  onOpened: (root: string, branch: string | null) => void;
  /** Called when a foreground load finds the path is no longer a repo. */
  onGone: (path: string) => void;
}) {
  const checkBuild = useStaleReload();
  const [session, setSession] = useState<SessionResponse | null>(null);
  /**
   * The repo and branch the session was loaded for. Every view request uses
   * this rather than `repo` and `ref`, so a switch keeps showing the last
   * view whole until the new session, and the rev it settles on, arrive
   * together.
   */
  const [shown, setShown] = useState<OpenView>({ repo: "", ref: null });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Set when a URL asked for a rev that isn't in the unpushed list. */
  const [revNotice, setRevNotice] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Ticks>({
    working: 0,
    review: 0,
    flows: 0,
    model: 0,
  });
  const bump = useCallback((names: (keyof Ticks)[]) => {
    if (names.length === 0) return;
    setTicks((current) => {
      const next = { ...current };
      for (const name of names) next[name] += 1;
      return next;
    });
  }, []);

  const repoRef = useRef(repo);
  const refRef = useRef(ref);
  /**
   * Kept in a ref so `loadSession` keeps its identity, and a page passing new
   * callbacks each render never reopens the stream.
   */
  const handlers = useRef({ setRev, setComment, onOpened, onGone });
  useEffect(() => {
    repoRef.current = repo;
  }, [repo]);
  useEffect(() => {
    refRef.current = ref;
  }, [ref]);
  useEffect(() => {
    handlers.current = { setRev, setComment, onOpened, onGone };
  });

  /** Discards out-of-order session responses from overlapping refreshes. */
  const seq = useRef(0);
  /**
   * The repo a foreground load opened and hasn't yet marked as looked at.
   * Whichever load of it shows first marks it, because the watch stream's
   * background load often supersedes the one that opened the branch.
   */
  const lookPending = useRef<string | null>(null);
  /**
   * Shas typed or pasted into the commit picker rather than chosen from the
   * list. The session only has the branch's recent commits, so without
   * remembering these the next background refresh would decide the rev didn't
   * exist and bounce you off it.
   */
  const pinned = useRef<string[]>([]);
  /**
   * Set when another repo or branch is opened, so its session starts the view
   * afresh. A commit picked on the last branch isn't this one's, and looking
   * it up here would claim it's already on GitHub.
   */
  const reopened = useRef(false);
  /** The root and branch `onOpened` last heard of, so a refresh doesn't repeat it. */
  const opened = useRef<string | null>(null);

  const loadSession = useCallback(
    async (
      path: string,
      opts: { background?: boolean; fresh?: boolean } = {},
    ) => {
      if (!path) {
        // Bump the sequence so a load still on its way for the last repo is
        // dropped, rather than opening it again over the inbox.
        seq.current += 1;
        lookPending.current = null;
        setSession(null);
        setError(null);
        setLoading(false);
        opened.current = null;
        return;
      }

      const mine = ++seq.current;
      const ref = refRef.current;
      // Background refreshes (watcher, focus) skip the loading state — a
      // spinner flashing on every keystroke-burst would be worse than the
      // staleness it replaces.
      if (!opts.background) {
        lookPending.current = path;
        setLoading(true);
        setError(null);
      }
      try {
        const data = await getJson<SessionResponse>(
          `/api/session?repo=${encodeURIComponent(path)}` +
            (ref ? `&ref=${encodeURIComponent(ref)}` : "") +
            (opts.fresh ? "&fresh=1" : ""),
        );
        if (mine !== seq.current) return;
        setSession(data);
        setShown((current) =>
          current.repo === path && current.ref === ref
            ? current
            : { repo: path, ref },
        );
        setError(null);
        const key = `${data.repo.root}\n${data.repo.branch ?? ""}`;
        if (opened.current !== key) {
          opened.current = key;
          handlers.current.onOpened(data.repo.root, data.repo.branch);
        }
        const shownTip = data.commits[0]?.sha ?? data.history[0]?.sha;
        if (lookPending.current === path && data.repo.branch && shownTip) {
          lookPending.current = null;
          void fetch(
            `/api/looked?repo=${encodeURIComponent(path)}&ref=${encodeURIComponent(data.repo.branch)}&tip=${shownTip}`,
            { method: "POST" },
          ).catch(() => {
            // The inbox shows the branch as changed a while longer, nothing worse.
          });
        }

        handlers.current.setComment((current) =>
          resolveComment(current, data.github.threads),
        );

        const fresh = reopened.current;
        reopened.current = false;
        if (fresh) pinned.current = [];
        handlers.current.setRev((current) => {
          // History counts: a URL can point at an already-pushed commit and
          // that's a perfectly good thing to view.
          const { rev: next, notice } = resolveRev(
            fresh ? WORKING_REV : current,
            [...data.commits, ...data.history],
            data.working.hasChanges,
            data.branchDiff !== null,
            pinned.current,
          );
          setRevNotice(notice);
          return next;
        });
      } catch (err) {
        if (mine !== seq.current) return;
        // A background failure keeps the last good view — the repo may just
        // be mid-rebase or briefly locked; the next event will retry.
        if (!opts.background) {
          setSession(null);
          setError(err instanceof Error ? err.message : String(err));
          opened.current = null;
          if (
            err instanceof ApiFetchError &&
            (err.kind === "missing-path" || err.kind === "not-a-repo")
          ) {
            handlers.current.onGone(path);
          }
        }
      } finally {
        if (mine === seq.current && !opts.background) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches when its key changes
    void loadSession(repo);
    // `ref` matters as much as the path: two branches of one stack are
    // reviewed from the same worktree, so switching between them changes
    // nothing else.
  }, [ready, repo, ref, loadSession]);

  // Catch up on focus, the Cmd-Tab-into-the-window moment, on anything that
  // changed while the window was in the background.
  useEffect(() => {
    if (!ready) return;

    const catchUp = async () => {
      if (await checkBuild()) return;
      bump(["working", "review", "model"]);
      void loadSession(repoRef.current, { background: true });
    };

    window.addEventListener("focus", catchUp);
    return () => window.removeEventListener("focus", catchUp);
  }, [ready, loadSession, checkBuild, bump]);

  // Live updates: one SSE stream per repo. The server watches the repo's
  // filesystem and pushes a debounced event when git state or the working
  // tree changes; the window reads again instead of the user hitting reload.
  useEffect(() => {
    if (!ready || !repo) return;

    const source = new EventSource(
      `/api/watch?repo=${encodeURIComponent(repo)}`,
    );

    source.onopen = () => {
      void checkBuild();
      // Reconnects (server restarted, laptop woke) mean missed events —
      // catch up once, bypassing the GitHub cache since time has passed.
      bump(["working", "review"]);
      void loadSession(repo, { background: true, fresh: true });
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

      const { bump: names, reload } = onWatch(kinds);
      bump(names);
      if (reload) void loadSession(repo, { background: true, ...reload });
    };

    return () => source.close();
  }, [ready, repo, loadSession, checkBuild, bump]);

  const reload = useCallback(
    (fresh = false) => void loadSession(repo, { fresh }),
    [repo, loadSession],
  );

  const reopen = useCallback(() => {
    reopened.current = true;
  }, []);

  /** Remembers a sha the session doesn't list, so a pasted one survives the next refresh. */
  const pin = useCallback(
    (sha: string) => {
      if (
        session &&
        !session.commits.some((c) => c.sha === sha) &&
        !session.history.some((c) => c.sha === sha)
      )
        pinned.current = [...new Set([...pinned.current, sha])];
    },
    [session],
  );

  const dismissNotice = useCallback(() => setRevNotice(null), []);
  const bumpModel = useCallback(() => bump(["model"]), [bump]);

  return {
    session,
    shown,
    loading,
    error,
    revNotice,
    dismissNotice,
    reload,
    reopen,
    pin,
    ticks,
    bumpModel,
  };
}
