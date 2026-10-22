"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChangeHeader } from "@/components/ChangeHeader";
import { ClaudeCodeGate } from "@/components/ClaudeCodeGate";
import { Comments } from "@/components/Comments";
import { FeedbackBar } from "@/components/FeedbackBar";
import { FilesChanged, type FilesJump } from "@/components/FilesChanged";
import type { StoryTarget } from "@/components/FlowCard";
import {
  badgeKey,
  type ComponentInfo,
  type DataField,
  type StepBadge,
} from "@/components/FlowSequence";
import { Story } from "@/components/Story";
import { Tabs } from "@/components/Tabs";
import { findings as designQuestions } from "@/lib/findings";
import type { DataResponse } from "@/lib/data/types";
import type { MapResponse } from "@/lib/map";
import { useFlows } from "@/components/useFlows";
import { useNotes, type NotesApi } from "@/components/useNotes";
import { useOutbox, type OutboxApi } from "@/components/useOutbox";
import { useReview, type ReviewApi } from "@/components/useReview";
import {
  stepMarks,
  stepsAt,
  type FlowRow,
  type StepAt,
  type StepMark,
} from "@/lib/flows/rows";
import { AlertIcon } from "@/components/icons";
import { Inbox } from "@/components/Inbox";
import { RepoBrowser } from "@/components/RepoBrowser";
import { ConnectGitHubLink } from "@/components/SetupChecklist";
import { PrTitle } from "@/components/PrTitle";
import { useStaleReload } from "@/components/useStaleReload";
import { ViewProvider, type OpenView } from "@/components/ViewContext";
import { pushedState } from "@/lib/pushed";
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
  resolveTab,
  viewKey,
  viewParams,
  writeUrlState,
  type Tab,
} from "@/lib/url";
import type {
  ApiError,
  CommitSummary,
  DiffResponse,
  Note,
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

/**
 * The repo's notes, agent review and outbox, held only while a repo is open
 * so the inbox asks for none of them.
 */
function WithReview({
  root,
  tick,
  children,
}: {
  root: string;
  tick: number;
  children: (api: {
    notes: NotesApi;
    review: ReviewApi;
    outbox: OutboxApi;
  }) => React.ReactNode;
}) {
  const notes = useNotes(root);
  const review = useReview(root, tick);
  const outbox = useOutbox(root, tick, notes.reload);
  return children({ notes, review, outbox });
}

export default function Page() {
  const [repoPath, setRepoPath] = useState("");
  /** A branch to review instead of the worktree's own. Null = the checkout. */
  const [ref, setRef] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const checkBuild = useStaleReload();

  const [session, setSession] = useState<SessionResponse | null>(null);
  /**
   * The repo and branch the session was loaded for. Every view request uses
   * this rather than `repoPath` and `ref`, so a switch keeps showing the last
   * view whole until the new session, and the rev it settles on, arrive
   * together.
   */
  const [shown, setShown] = useState<OpenView>({ repo: "", ref: null });
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  const [rev, setRev] = useState<string>(WORKING_REV);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  /** The view the diff on screen was read for: its `rev` alone doesn't name the branch. */
  const [diffView, setDiffView] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  /** Set when a URL asked for a rev that isn't in the unpushed list. */
  const [revNotice, setRevNotice] = useState<string | null>(null);
  /** True while the watch stream is connected — shown as the live dot. */
  const [live, setLive] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  /** `?setup=1`: the inbox shows the setup checklist whatever else it holds */
  const [setup, setSetup] = useState(false);
  /** Previously-opened repos for the RepoBar dropdown. */
  const [recents, setRecents] = useState<RecentRepo[]>([]);

  /** The focused review thread, outlined in Comments. */
  const [commentId, setCommentId] = useState<string | null>(null);
  /** Focus asked for from outside Comments, which scrolls the thread into view. */
  const [focusAsk, setFocusAsk] = useState<{ id: string; at: number } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("story");
  /** Bumped by watcher events; retriggers the working-tree diff fetch. */
  const [workingTick, setWorkingTick] = useState(0);
  /**
   * Bumped when an agent starts or stops waiting for a review, or a sent
   * round is queued, collected or withdrawn.
   */
  const [reviewTick, setReviewTick] = useState(0);
  /** Bumped when a flow run finishes. */
  const [flowsTick, setFlowsTick] = useState(0);
  const flowNavRef = useRef<((delta: number) => boolean) | null>(null);
  /** Keeps the map with the view it was read for, as `dataRead` does the data model. */
  const [mapRead, setMapRead] = useState<{
    view: string;
    map: MapResponse;
  } | null>(null);
  /** Bumped when a model or data model draft is written, so both are read again */
  const [modelTick, setModelTick] = useState(0);
  const onModelChange = useCallback(() => setModelTick((t) => t + 1), []);
  /**
   * Keeps the data with the view it was read for, and shows none while
   * another view's read is on the way, so the story never offers a paid
   * Read again for one view beside the data model of another.
   */
  const [dataRead, setDataRead] = useState<{
    view: string;
    data: DataResponse;
  } | null>(null);
  const viewId = viewKey({ ...shown, rev });
  const map = mapRead?.view === viewId ? mapRead.map : null;
  const dataModel = dataRead?.view === viewId ? dataRead.data : null;
  const revRef = useRef(rev);
  const repoRef = useRef(repoPath);
  const refRef = useRef(ref);
  /** Discards out-of-order session responses from overlapping refreshes. */
  const sessionSeq = useRef(0);
  /**
   * The repo a foreground load opened and hasn't yet marked as looked at.
   * Whichever load of it shows first marks it, because the watch stream's
   * background load often supersedes the one that opened the branch.
   */
  const lookPending = useRef<string | null>(null);
  /**
   * Shas typed or pasted into the commit picker rather than chosen from the
   * list. The session only carries the branch's recent commits, so without
   * remembering these the next background refresh would decide the rev didn't
   * exist and bounce you off it.
   */
  const pickedRevs = useRef<string[]>([]);
  /**
   * Set when another repo or branch is opened, so its session starts the view
   * afresh. A commit picked on the last branch isn't this one's, and looking
   * it up here would claim it's already on GitHub.
   */
  const reopened = useRef(false);
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

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is only readable after mount
    setRepoPath(path);
    setRef(fromUrl.ref ?? null);
    setSetup(Boolean(fromUrl.setup));
    if (fromUrl.rev) setRev(fromUrl.rev);
    setTab(resolveTab(fromUrl));
    if (fromUrl.comment) {
      setCommentId(fromUrl.comment);
      setFocusAsk({ id: fromUrl.comment, at: Date.now() });
    }
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- recents live in localStorage, kept in step with the session
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
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

  const forgetRoot = useCallback((roots: string[]) => {
    const drop = new Set(roots);
    setInboxRoots((current) => {
      const next = current.filter((r) => !drop.has(r));
      try {
        window.localStorage.setItem(INBOX_ROOTS_KEY, JSON.stringify(next));
      } catch {
        // As above.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inbox roots live in localStorage, kept in step with the session
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
      {
        repo: repoPath || null,
        ref,
        rev,
        comment: commentId,
        tab: inWorkspace ? tab : undefined,
        setup: setup && !inWorkspace,
      },
      { push: inWorkspace !== wasInWorkspace.current },
    );
    wasInWorkspace.current = inWorkspace;
  }, [ready, repoPath, ref, rev, commentId, tab, setup]);

  // Someone navigating with the back/forward buttons, or editing the URL by
  // hand, should land on the view they asked for.
  useEffect(() => {
    const onPopState = () => {
      const fromUrl = readUrlState();
      setRepoPath(fromUrl.repo ?? "");
      setRef(fromUrl.ref ?? null);
      setRev(fromUrl.rev ?? WORKING_REV);
      setCommentId(fromUrl.comment);
      setTab(resolveTab(fromUrl));
      setSetup(Boolean(fromUrl.setup));
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
      const ref = refRef.current;
      // Background refreshes (watcher, focus) skip the loading state — a
      // spinner flashing on every keystroke-burst would be worse than the
      // staleness it replaces.
      if (!opts.background) {
        lookPending.current = path;
        setSessionLoading(true);
        setSessionError(null);
      }
      try {
        const data = await getJson<SessionResponse>(
          `/api/session?repo=${encodeURIComponent(path)}` +
            (ref ? `&ref=${encodeURIComponent(ref)}` : "") +
            (opts.fresh ? "&fresh=1" : ""),
        );
        if (seq !== sessionSeq.current) return; // superseded by a newer fetch
        setSession(data);
        setShown((current) =>
          current.repo === path && current.ref === ref
            ? current
            : { repo: path, ref },
        );
        setSessionError(null);
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

        setCommentId((current) => resolveComment(current, data.github.threads));

        const fresh = reopened.current;
        reopened.current = false;
        if (fresh) pickedRevs.current = [];
        setRev((current) => {
          // History counts: a URL can point at an already-pushed commit and
          // that's a perfectly good thing to view.
          const { rev: next, notice } = resolveRev(
            fresh ? WORKING_REV : current,
            [...data.commits, ...data.history],
            data.working.hasChanges,
            data.branchDiff !== null,
            pickedRevs.current,
          );
          setRevNotice(notice);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches when its key changes
    void loadSession(repoPath);
    // `ref` matters as much as the path: two branches of one stack are
    // reviewed from the same worktree, so switching between them changes
    // nothing else.
  }, [ready, repoPath, ref, loadSession]);

  // Start reading main's data model and map as a repo opens, while a pull
  // request is still being chosen. The server starts each unless the repo is
  // turned off or main has a model of that kind already.
  useEffect(() => {
    if (!ready || !repoPath) return;
    const trunk = `repo=${encodeURIComponent(repoPath)}&trunk=1`;
    for (const api of ["data", "map"])
      void fetch(`/api/${api}?${trunk}`, { method: "POST" }).catch(() => {});
  }, [ready, repoPath]);

  // Catch up on focus, the Cmd-Tab-into-the-window moment, on anything that
  // changed while the window was in the background.
  useEffect(() => {
    if (!ready) return;

    const catchUp = async () => {
      if (await checkBuild()) return;
      setWorkingTick((t) => t + 1);
      setReviewTick((t) => t + 1);
      setModelTick((t) => t + 1);
      void loadSession(repoRef.current, { background: true });
    };

    window.addEventListener("focus", catchUp);
    return () => window.removeEventListener("focus", catchUp);
  }, [ready, loadSession, checkBuild]);

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
      void checkBuild();
      // Reconnects (server restarted, laptop woke) mean missed events —
      // catch up once, bypassing the GitHub cache since time has passed.
      setWorkingTick((t) => t + 1);
      setReviewTick((t) => t + 1);
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

      const agentKinds = ["review", "outbox"];
      if (kinds.some((kind) => agentKinds.includes(kind)))
        setReviewTick((t) => t + 1);
      if (kinds.includes("flows")) setFlowsTick((t) => t + 1);
      // A review request, a queued round or a finished flow run changes
      // nothing on disk.
      if (kinds.every((kind) => kind === "flows" || agentKinds.includes(kind)))
        return;

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
  }, [ready, repoPath, loadSession, checkBuild]);

  const haveSession = session !== null;
  // A commit's diff is immutable, so watcher ticks only matter for the two
  // views that move — uncommitted work, and the branch diff (its tip end
  // advances with every commit); pinning the key otherwise keeps background
  // session refreshes from refetching a diff that cannot have changed. A
  // branch opened by ref keys on its base and tip instead: saves in the
  // checkout fire watcher ticks, but can't move another branch.
  const branchEnds = shown.ref
    ? `${session?.base.sha}..${session?.commits[0]?.sha}`
    : workingTick;
  const workingDiffKey =
    rev === WORKING_REV || rev === BRANCH_REV ? branchEnds : -1;

  useEffect(() => {
    revRef.current = rev;
    if (!shown.repo || !haveSession) return;

    let cancelled = false;
    // Watcher-driven refetches of the working diff keep the old content on
    // screen until the new one arrives; only a rev switch shows the loader.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows the loader, then fetches the new rev
    setDiffLoading(true);
    setDiffError(null);

    getJson<DiffResponse>(
      `/api/diff?${viewParams({ repo: shown.repo, ref: shown.ref, rev })}`,
    )
      .then((data) => {
        if (cancelled) return;
        setDiff(data);
        setDiffView(viewId);
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
  }, [shown, rev, viewId, haveSession, workingDiffKey]);

  // The map follows the diff: a commit's never changes; the branch's moves
  // with its tip.
  useEffect(() => {
    if (!shown.repo || !haveSession || rev === WORKING_REV) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the map where there is none, else fetches it
      setMapRead(null);
      setDataRead(null);
      return;
    }
    let cancelled = false;
    const query = viewParams({ repo: shown.repo, ref: shown.ref, rev });
    getJson<MapResponse>(`/api/map?${query}`)
      .then((data) => !cancelled && setMapRead({ view: viewId, map: data }))
      .catch(() => !cancelled && setMapRead(null));
    getJson<DataResponse>(`/api/data?${query}`)
      .then((data) => !cancelled && setDataRead({ view: viewId, data }))
      .catch(() => !cancelled && setDataRead(null));
    return () => {
      cancelled = true;
    };
  }, [shown, rev, viewId, haveSession, workingDiffKey, modelTick]);

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

  const revIsPushed = useMemo(
    () => (session ? pushedState(session, rev) === true : false),
    [session, rev],
  );

  /**
   * Already ordered oldest first server-side, so the 💬 numbers, "Comment i of
   * N" and `j`/`k` agree.
   */
  const threads = useMemo(() => session?.github.threads ?? [], [session]);

  /**
   * Whether there are comments to show at all. Not "is there a PR": a draft
   * PR nobody has reviewed has a PR and nothing for the Comments tab.
   */
  const hasComments = threads.length > 0;

  // Only once the session says there are none: before it loads, a
  // ?comment= link's tab must survive.
  if (session && !hasComments && tab === "comments") setTab("story");

  // A tab mounts the first time it's opened and stays mounted, so a note
  // being typed in Files changed or a step open in the story survives a
  // look at another tab, and a landing on Story never renders the diff.
  // Waits for `ready`: until the URL is read, `tab` is the default, and a
  // ?tab=files link would mount Story too.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set());
  if (ready && !visited.has(tab)) setVisited(new Set([...visited, tab]));

  // "All changes" follows the branch's tip: when the diff is fetched again, so are its
  // flows, or the last head's flows would sit on the new head's lines.
  const flows = useFlows(
    session ? shown.repo : "",
    shown.ref,
    rev,
    `${flowsTick}:${workingDiffKey}`,
  );
  const flowSet = flows.status?.status === "ready" ? flows.status.flows : null;

  /** A flow and step for Story to open, from a gutter mark, a badge or a comment. */
  const [storyTarget, setStoryTarget] = useState<StoryTarget | null>(null);
  /** A file or line for Files changed to bring up once it renders. */
  const [filesJump, setFilesJump] = useState<FilesJump | null>(null);
  /** A component for the map to outline, from a Files changed group. */
  const [mapHighlight, setMapHighlight] = useState<{
    name: string;
    at: number;
  } | null>(null);
  /** The filter Files changed opens with, from "read these yourself". */
  const [filesFilter, setFilesFilter] = useState<{
    filter: "yourself";
    at: number;
  } | null>(null);

  // Reset while rendering, not in an effect, so a new view never paints
  // with the last one's requests.
  const [shownView, setShownView] = useState(viewId);
  if (shownView !== viewId) {
    setShownView(viewId);
    setStoryTarget(null);
    if (filesJump?.view !== viewId) setFilesJump(null);
    setMapHighlight(null);
    setFilesFilter(null);
  }

  const showInFiles = useCallback((row: FlowRow) => {
    setFilesJump({
      path: row.step.file,
      side: row.side,
      line: row.step.line,
      at: Date.now(),
    });
    setTab("files");
  }, []);

  const clearFilesJump = useCallback(() => setFilesJump(null), []);

  // Clear a target once a card has opened it, or a regenerate's remount would
  // open it again and scroll the window from behind another tab.
  const clearStoryTarget = useCallback(
    (at: number) => setStoryTarget((t) => (t?.at === at ? null : t)),
    [],
  );

  const openFile = useCallback((path: string) => {
    setFilesJump({ path, at: Date.now() });
    setTab("files");
  }, []);

  const openStep = useCallback((mark: Pick<StepMark, "flow" | "row">) => {
    setStoryTarget({ flow: mark.flow, row: mark.row, at: Date.now() });
    setTab("story");
  }, []);

  const showOnMap = useCallback((name: string) => {
    setMapHighlight({ name, at: Date.now() });
    setTab("story");
  }, []);

  const showYourself = useCallback(() => {
    setFilesFilter({ filter: "yourself", at: Date.now() });
    setTab("files");
    window.scrollTo({ top: 0 });
  }, []);

  // The last view's diff stays on screen while this one's loads; this view's
  // flows must wait for it, or their marks sit on the old diff's lines.
  const diffIsCurrent = diff !== null && diffView === viewId;

  /** Every flow's steps, by the diff line each sits on, for the gutter marks. */
  const marks = useMemo(() => (flowSet ? stepMarks(flowSet) : null), [flowSet]);

  /** Notes on the change's shape, pinned on the data cards and under flow titles. */
  const questions = useMemo(
    () => designQuestions(flowSet, dataModel),
    [flowSet, dataModel],
  );
  const entityNotes = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const q of questions) {
      if (q.on.entity)
        out.set(q.on.entity, [
          ...(out.get(q.on.entity) ?? []),
          q.short.replace(`${q.on.entity} gains `, ""),
        ]);
    }
    return out;
  }, [questions]);
  const flowNotes = useMemo(() => {
    const out = new Map<number, string[]>();
    for (const q of questions) {
      for (const [i, text] of Object.entries(q.flowText ?? {})) {
        out.set(Number(i), [...(out.get(Number(i)) ?? []), text]);
      }
    }
    return out;
  }, [questions]);

  /** Fields the change touched, for chips on the flow steps that use them. */
  const dataFields = useMemo(
    () =>
      (dataModel?.entities ?? []).flatMap((e) =>
        e.fields
          .filter((f) => f.state !== "same")
          .map((f) => ({
            entity: e.name,
            field: f.item.name,
            state: f.state as DataField["state"],
          })),
      ),
    [dataModel],
  );

  /** What the map says of each component, for the flow's component boxes. */
  const componentInfo = useMemo(() => {
    const info = new Map<string, ComponentInfo>();
    for (const [name, description] of Object.entries(map?.descriptions ?? {})) {
      info.set(name, { description, state: "neighbour" });
    }
    for (const n of map?.nodes ?? []) {
      if (n.state !== "neighbour")
        info.set(n.name, { description: n.description, state: n.state });
    }
    return info;
  }, [map]);

  /** Each thread's number, oldest first, for the marks that name it. */
  const commentNumbers = useMemo(
    () => new Map(threads.map((t, i) => [t.id, i + 1])),
    [threads],
  );

  /** The flow step each thread's line is on, where one is. */
  const threadSteps = useMemo(() => {
    const out = new Map<string, StepAt>();
    if (!flowSet) return out;
    for (const t of threads) {
      const line = t.line ?? t.originalLine;
      if (!t.path || line == null) continue;
      const at = stepsAt(
        flowSet,
        t.path,
        line,
        t.side === "LEFT" ? "old" : "new",
      );
      if (at) out.set(t.id, at);
    }
    return out;
  }, [flowSet, threads]);

  /** Each flow's comment badges, by step. */
  const badges = useMemo(() => {
    const out = new Map<number, Map<string, StepBadge[]>>();
    for (const t of threads) {
      const at = threadSteps.get(t.id);
      if (!at) continue;
      const flow = out.get(at.flow - 1) ?? new Map<string, StepBadge[]>();
      const key = badgeKey(at.row);
      flow.set(key, [
        ...(flow.get(key) ?? []),
        { id: t.id, n: commentNumbers.get(t.id) ?? 0 },
      ]);
      out.set(at.flow - 1, flow);
    }
    return out;
  }, [threads, threadSteps, commentNumbers]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === commentId) ?? null,
    [threads, commentId],
  );

  /** Focusing a comment opens Comments on it, and leaves the change alone. */
  const selectComment = useCallback((id: string) => {
    setCommentId(id);
    setFocusedThreadId(id);
    setFocusAsk({ id, at: Date.now() });
    setTab("comments");
  }, []);

  /** Back to the home screen. Clearing the repo is what the inbox *is*. */
  const backToInbox = useCallback(() => {
    setRepoPath("");
    setRef(null);
    setSession(null);
    setSessionError(null);
    setCommentId(null);
    setRev(WORKING_REV);
    setTab("story");
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
    if (trimmed !== repoRef.current || (branch ?? null) !== refRef.current)
      reopened.current = true;
    setRef(branch ?? null);
    setRepoPath(trimmed);
    setSetup(false);
    setTab("story");
  }, []);

  /** A change picked above the tabs: it opens on Story, as every view does. */
  const pickRev = useCallback(
    (next: string) => {
      // Remember anything that isn't in the offered list, so a pasted sha
      // survives the next refresh.
      if (
        session &&
        !session.commits.some((c) => c.sha === next) &&
        !session.history.some((c) => c.sha === next)
      ) {
        pickedRevs.current = [...new Set([...pickedRevs.current, next])];
      }
      setRev(next);
      setTab("story");
    },
    [session],
  );

  // The change on screen as a note records it: a commit by its full sha,
  // which is what stays comparable across views. Null until the diff showing
  // is this change's — for a moment after switching it's still the last one,
  // and a note left then would be filed against the wrong change.
  const noteRev = useMemo(() => {
    if (!diffIsCurrent) return null;
    if (rev === WORKING_REV || rev === BRANCH_REV) return rev;
    if (commitForRev && /^[0-9a-f]{40}$/.test(commitForRev.sha))
      return commitForRev.sha;
    return /^[0-9a-f]{40}$/.test(rev) ? rev : null;
  }, [diffIsCurrent, rev, commitForRev]);

  const openNote = useCallback(
    (note: Note) => {
      if (note.rev !== noteRev) pickRev(note.rev);
      if (note.path)
        setFilesJump({
          path: note.path,
          side: note.side,
          line: note.line ?? undefined,
          note: note.id,
          view: viewKey({ ...shown, rev: note.rev }),
          at: Date.now(),
        });
      setTab("files");
    },
    [noteRev, pickRev, shown],
  );

  // j/k move through a list the way they would in a TUI, the open tab's:
  // flow steps on Story, comments on Comments, changes on Files changed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "j" && event.key !== "k") return;

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

      if (tab === "comments") {
        const ids = threads.map((t) => t.id);
        const at = commentId ? ids.indexOf(commentId) : -1;
        // With nothing focused, either key starts at the first comment.
        const step = at === -1 ? 0 : event.key === "j" ? at + 1 : at - 1;
        if (step < 0 || step >= ids.length) return;

        event.preventDefault();
        selectComment(ids[step]);
        return;
      }

      // On Story, j/k walk the steps of the topmost open flow; with none to
      // walk, they move changes as Files changed does.
      if (tab === "story" && flowNavRef.current?.(event.key === "j" ? 1 : -1)) {
        event.preventDefault();
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
  }, [session, rev, threads, commentId, selectComment, tab]);

  return (
    <ClaudeCodeGate>
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
              onAdd={rememberRoot}
              onBrowse={() => setBrowsing(true)}
              onForget={forgetRoot}
              setupAsked={setup}
              onSetupDone={() => setSetup(false)}
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
          <ViewProvider value={shown}>
            <div className="flex items-start">
              <main className="min-w-0 flex-1 pb-16">
                <div className="mx-auto w-full max-w-[1280px] space-y-3 p-4 pt-3">
                  {session.github.pr && <PrTitle pr={session.github.pr} />}

                  {revNotice && (
                    <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                      <AlertIcon
                        size={13}
                        className="mt-0.5 shrink-0 text-[var(--attention)]"
                      />
                      <span className="flex-1">
                        <span className="mono">{revNotice}</span> isn&apos;t
                        waiting to be pushed any more — it may already be on
                        GitHub. Showing the latest instead.
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
                      {session.github.connect && (
                        <>
                          {" "}
                          <ConnectGitHubLink />
                        </>
                      )}
                    </p>
                  )}

                  <ChangeHeader
                    session={session}
                    rev={rev}
                    onRevChange={pickRev}
                    commit={commitForRev}
                    diff={diff}
                    thread={selectedThread}
                    pushed={revIsPushed}
                  />

                  <Tabs
                    tab={tab}
                    onTab={setTab}
                    fileCount={diffIsCurrent ? diff.files.length : null}
                    threads={threads}
                  />

                  <WithReview root={session.repo.root} tick={reviewTick}>
                    {({ notes, review, outbox }) => (
                      <>
                        {visited.has("story") && (
                          <div hidden={tab !== "story"}>
                            <Story
                              repo={shown.repo}
                              rev={rev}
                              map={map}
                              data={dataModel}
                              entityNotes={entityNotes}
                              onModelChange={onModelChange}
                              mapHighlight={mapHighlight}
                              onOpenFile={openFile}
                              flows={flows}
                              diff={diffIsCurrent ? diff : null}
                              onShowFiles={() => setTab("files")}
                              onShowYourself={showYourself}
                              target={storyTarget}
                              onTargetDone={clearStoryTarget}
                              onShowInFiles={showInFiles}
                              navRef={flowNavRef}
                              components={componentInfo}
                              dataFields={dataFields}
                              flowNotes={flowNotes}
                              badges={badges}
                              onBadge={selectComment}
                            />
                          </div>
                        )}
                        {visited.has("files") && (
                          <div hidden={tab !== "files"}>
                            <FilesChanged
                              view={viewId}
                              diff={diff}
                              loading={diffLoading}
                              error={diffError}
                              threads={threads}
                              repo={session.repo}
                              commit={commitForRev}
                              focusedThreadId={focusedThreadId}
                              notes={noteRev ? notes : null}
                              noteRev={noteRev}
                              map={map}
                              flowSet={diffIsCurrent ? flowSet : null}
                              marks={diffIsCurrent ? marks : null}
                              jump={filesJump}
                              onJumped={clearFilesJump}
                              filterAsk={filesFilter}
                              onShowOnMap={showOnMap}
                              commentNumbers={commentNumbers}
                              onStep={openStep}
                              onComment={selectComment}
                            />
                          </div>
                        )}
                        {hasComments && visited.has("comments") && (
                          <div hidden={tab !== "comments"}>
                            <Comments
                              threads={threads}
                              focusedId={commentId}
                              focusAsk={focusAsk}
                              onFocus={(id) => {
                                setCommentId(id);
                                setFocusedThreadId(id);
                              }}
                              fileComponents={map?.fileComponents ?? null}
                              threadSteps={threadSteps}
                              onOpenStep={(at) =>
                                openStep({ flow: at.flow - 1, row: at.row.key })
                              }
                              pr={session.github.pr}
                            />
                          </div>
                        )}

                        {/* Pinned to the bottom of the window on every tab: an
                        agent waiting on review must never be invisible, and
                        notes written in Files changed are sent from anywhere. */}
                        {(noteRev ||
                          notes.notes.length > 0 ||
                          review.waiting ||
                          review.error) && (
                          <div className="sticky bottom-4 z-20">
                            <FeedbackBar
                              notes={notes}
                              noteRev={noteRev}
                              diff={noteRev ? diff : null}
                              session={session}
                              review={review}
                              outbox={outbox}
                              onOpenNote={openNote}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </WithReview>
                </div>
              </main>
            </div>
          </ViewProvider>
        ) : null}
      </div>
    </ClaudeCodeGate>
  );
}
