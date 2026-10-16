"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChangeHeader, openingChangeFor } from "@/components/ChangeHeader";
import { Comments } from "@/components/Comments";
import { FeedbackBar } from "@/components/FeedbackBar";
import { FilesChanged, type FilesJump } from "@/components/FilesChanged";
import type { StoryTarget } from "@/components/FlowCard";
import type { ComponentInfo, DataField } from "@/components/FlowSequence";
import { Story } from "@/components/Story";
import { Tabs } from "@/components/Tabs";
import { findings as designQuestions } from "@/lib/findings";
import type { DataResponse } from "@/lib/data/types";
import type { MapResponse } from "@/lib/map";
import { useFlows } from "@/components/useFlows";
import { useNotes, type NotesApi } from "@/components/useNotes";
import { useOutbox, type OutboxApi } from "@/components/useOutbox";
import { useReview, type ReviewApi } from "@/components/useReview";
import { stepMarks, type FlowRow } from "@/lib/flows/rows";
import { AlertIcon } from "@/components/icons";
import { Inbox } from "@/components/Inbox";
import { RepoBrowser } from "@/components/RepoBrowser";
import { ConnectGitHubLink } from "@/components/SetupChecklist";
import { PrTitle } from "@/components/PrTitle";
import { TickSpine, TickStrip } from "@/components/TickSpine";
import { useStaleReload } from "@/components/useStaleReload";
import { pushedState } from "@/lib/pushed";
import { RepoBar } from "@/components/RepoBar";
import {
  BRANCH_REV,
  INBOX_ROOTS_KEY,
  STORAGE_KEY,
  WORKING_REV,
} from "@/lib/constants";
import {
  confirmedDrafts,
  keyFor,
  withDrafts,
  type PendingDraft,
} from "@/lib/drafts";
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
  writeUrlState,
  type Tab,
} from "@/lib/url";
import type {
  ApiError,
  CommitSummary,
  DiffResponse,
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
  /** `?setup=1`: the inbox shows the setup checklist whatever else it holds */
  const [setup, setSetup] = useState(false);
  /** Previously-opened repos for the RepoBar dropdown. */
  const [recents, setRecents] = useState<RecentRepo[]>([]);

  /** The focused review thread: marked on the spine, outlined in Comments. */
  const [commentId, setCommentId] = useState<string | null>(null);
  /** Focus asked for from outside Comments, which scrolls the thread into view. */
  const [focusAsk, setFocusAsk] = useState<{ id: string; at: number } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("story");
  /** Set when a URL asked for a comment that isn't in this PR. */
  const [commentNotice, setCommentNotice] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
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
  const [map, setMap] = useState<MapResponse | null>(null);
  /** Bumped when a model or data model draft is written, so both are read again */
  const [modelTick, setModelTick] = useState(0);
  const onModelChange = useCallback(() => setModelTick((t) => t + 1), []);
  /**
   * Keeps the data with the view it was read for, and shows none while
   * another view's read is on the way, so the data strip never offers a paid
   * Redraft for one view beside the model of another.
   */
  const [dataRead, setDataRead] = useState<{
    view: string;
    data: DataResponse;
  } | null>(null);
  const dataView = `${repoPath}\n${rev}`;
  const dataModel = dataRead?.view === dataView ? dataRead.data : null;
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
  /**
   * Drafts you've typed that the store hasn't confirmed yet.
   *
   * The client, not the disk, is what the box reads from between a keystroke
   * and the write landing — so this is where a draft lives while it's in
   * flight, and where it stays if the write fails. Entries only leave once
   * the store has acknowledged that exact text, which is also what makes it
   * safe for a background refresh to overwrite everything else.
   */
  const pendingDrafts = useRef(new Map<string, PendingDraft>());
  const flushingDrafts = useRef(new Set<string>());
  /** Set when a draft has run out of retries and is still only in memory. */
  const [draftNotice, setDraftNotice] = useState(false);

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
            (refRef.current
              ? `&ref=${encodeURIComponent(refRef.current)}`
              : "") +
            (opts.fresh ? "&fresh=1" : ""),
        );
        if (seq !== sessionSeq.current) return; // superseded by a newer fetch
        // Anything you've typed that this data doesn't already show outranks
        // what came back: either the store hadn't been told yet, or it had
        // and this read was already in flight when it was.
        const key = keyFor(data);
        for (const id of confirmedDrafts(data, pendingDrafts.current, key)) {
          pendingDrafts.current.delete(id);
        }
        setSession(withDrafts(data, pendingDrafts.current, key));
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
          // Uncommitted diff. Only ever a fallback — an explicit rev, and
          // anything you pick later, wins.
          if (next === WORKING_REV && !data.working.hasChanges) {
            const thread = data.github.threads.find((t) => t.id === landedOn);
            const linked = thread?.response.commits.find((c) => !c.missing);
            if (linked) return linked.sha;
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches when its key changes
    void loadSession(repoPath);
    // `ref` matters as much as the path: two branches of one stack are
    // reviewed from the same worktree, so switching between them changes
    // nothing else.
  }, [ready, repoPath, ref, loadSession]);

  // Catch up on focus, the Cmd-Tab-into-the-window moment, on anything that
  // changed while the window was in the background.
  useEffect(() => {
    if (!ready) return;

    const catchUp = async () => {
      if (await checkBuild()) return;
      setWorkingTick((t) => t + 1);
      setReviewTick((t) => t + 1);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows the loader, then fetches the new rev
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

  // The map follows the diff: a commit's never changes; the branch's moves
  // with HEAD.
  useEffect(() => {
    if (!repoPath || !haveSession || rev === WORKING_REV) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the map where there is none, else fetches it
      setMap(null);
      setDataRead(null);
      return;
    }
    let cancelled = false;
    const query = `repo=${encodeURIComponent(repoPath)}&rev=${encodeURIComponent(rev)}`;
    getJson<MapResponse>(`/api/map?${query}`)
      .then((data) => !cancelled && setMap(data))
      .catch(() => !cancelled && setMap(null));
    getJson<DataResponse>(`/api/data?${query}`)
      .then(
        (data) =>
          !cancelled && setDataRead({ view: `${repoPath}\n${rev}`, data }),
      )
      .catch(() => !cancelled && setDataRead(null));
    return () => {
      cancelled = true;
    };
  }, [repoPath, rev, haveSession, workingDiffKey, modelTick]);

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
   * Already ordered by file server-side, so the spine's grouping gaps, the
   * stepper and `j`/`k` all agree with the "first open comment" fallback.
   */
  const threads = useMemo(() => session?.github.threads ?? [], [session]);

  /**
   * Whether there's a checklist to show at all. Not "is there a PR": this
   * branch has a draft PR nobody has reviewed, which is exactly the case
   * where the Comments tab and the spine are dead weight.
   */
  const hasComments = threads.length > 0;

  // Only once the session says there are none: before it loads, a
  // ?comment= link's tab must survive.
  if (session && !hasComments && tab === "comments") setTab("story");

  // A tab mounts the first time it's opened and stays mounted, so a note
  // being typed in Files changed or a step open in the story survives a
  // look at another tab, and a landing on Story never renders the diff.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));

  // "All changes" follows HEAD: when the diff is fetched again, so are its
  // flows, or the last head's flows would sit on the new head's lines.
  const flows = useFlows(
    session ? repoPath : "",
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

  const viewKey = `${repoPath}@${rev}`;
  // Reset while rendering, not in an effect, so a new view never paints
  // with the last one's requests.
  const [shownView, setShownView] = useState(viewKey);
  if (shownView !== viewKey) {
    setShownView(viewKey);
    setStoryTarget(null);
    setFilesJump(null);
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

  const openFile = useCallback((path: string) => {
    setFilesJump({ path, at: Date.now() });
    setTab("files");
  }, []);

  const showYourself = useCallback(() => {
    setFilesFilter({ filter: "yourself", at: Date.now() });
    setTab("files");
    window.scrollTo({ top: 0 });
  }, []);

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

  /**
   * Commits a thread can be pinned to: the unpushed ones first, then a slice
   * of pushed history. The right commit is often neither the guess nor the
   * selection — a fix can land in a different file from the one commented on
   * — so the picker has to offer the whole branch.
   */
  const pinCandidates = useMemo(
    () => [
      ...(session?.commits ?? []),
      ...(session?.history ?? []).slice(0, 15),
    ],
    [session],
  );

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === commentId) ?? null,
    [threads, commentId],
  );

  /**
   * Focusing a comment opens Comments on it, and the change on its linked
   * commit if it has one — never a guess about which commit answers it.
   * Picking a commit leaves the comment alone, so the two stay separate axes.
   */
  const selectComment = useCallback(
    (id: string) => {
      setCommentId(id);
      setFocusedThreadId(id);
      setFocusAsk({ id, at: Date.now() });
      setTab("comments");
      const thread = threads.find((t) => t.id === id) ?? null;
      // null leaves the change alone: an unlinked comment has nothing to say
      // about which change you should be looking at.
      const linked = openingChangeFor(thread);
      if (linked) setRev(linked);
    },
    [threads],
  );

  /** Sent with every write; see `keyFor`. */
  const responseKey = useMemo(() => keyFor(session), [session]);

  const writeResponse = useCallback(
    async (
      threadId: string,
      patch: {
        done?: boolean;
        reply?: string | null;
        sha?: string | null;
        unlink?: string;
        clear?: boolean;
      },
      {
        // keepalive only where the write is fire-and-forget — a draft save or
        // a tick, which the UI has already reflected optimistically and never
        // waits on.
        keepalive = false,
        // A retry names the PR the text was typed on. Without that it would
        // use whatever is open when it finally succeeds, filing your reply
        // under a pull request it has nothing to do with.
        key = responseKey,
      }: { keepalive?: boolean; key?: string | null } = {},
    ): Promise<{ ok: boolean; error: string | null }> => {
      if (!key) return { ok: false, error: null };
      // `repo` rides along only so the server can compute a patch-id when a
      // commit is linked; ticks and drafts need no subprocess at all.
      const params = new URLSearchParams({ key });
      if (patch.sha) params.set("repo", repoPath);

      try {
        const response = await fetch(`/api/responses?${params}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, ...patch }),
          keepalive,
          // Nothing here should take ten seconds. A write that does has gone
          // wrong, and the UI needs to hear about it rather than wait.
          signal: keepalive ? undefined : AbortSignal.timeout(10_000),
        });

        // Always drain the body, even when there's nothing in it we need.
        // `fetch` resolves as soon as the headers land, so a response left
        // unread keeps the request open — it shows as "pending" in the
        // network inspector indefinitely, which reads exactly like a server
        // that never answered.
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;

        return { ok: response.ok, error: body?.error ?? null };
      } catch {
        // A failed write shouldn't break the view; the next action retries.
        return { ok: false, error: null };
      }
    },
    [responseKey, repoPath],
  );

  /**
   * Get a thread's pending draft onto disk, retrying a failure rather than
   * shrugging at it. A draft is the one thing here you can't reconstruct: a
   * tick is one click to redo and a link is one pick, but nobody can retype
   * what they wrote from memory.
   */
  const flushDraft = useCallback(
    async (threadId: string) => {
      // A pass is already looping on this thread; it re-reads the pending
      // text each time round, so it will pick up whatever was just typed.
      if (flushingDrafts.current.has(threadId)) return;
      flushingDrafts.current.add(threadId);

      try {
        for (let attempt = 0; ;) {
          const pending = pendingDrafts.current.get(threadId);
          if (!pending || pending.saved) return; // written, or discarded

          // keepalive so it survives the window closing mid-save.
          const { ok } = await writeResponse(
            threadId,
            { reply: pending.text },
            { keepalive: true, key: pending.key },
          );

          if (ok) {
            setDraftNotice(false);
            // Anything typed while that was in flight is now the draft, and
            // it needs a write of its own before this thread is clear.
            if (pendingDrafts.current.get(threadId) !== pending) {
              attempt = 0;
              continue;
            }
            // Kept, not dropped: the window goes on holding the text until a
            // session load comes back agreeing with it. Dropping it here
            // leaves a read that was already in flight free to paint the
            // older text back over the box.
            pendingDrafts.current.set(threadId, { ...pending, saved: true });
            return;
          }

          // Four goes over about eight seconds, then leave it pending: the
          // text is still on screen and in `pendingDrafts`, so the next
          // keystroke, the next focus, or a reconnect will try again.
          if (attempt >= 3) {
            setDraftNotice(true);
            return;
          }
          await sleep(500 * 2 ** attempt);
          attempt++;
        }
      } finally {
        flushingDrafts.current.delete(threadId);
      }
    },
    [writeResponse],
  );

  /** Retry everything still unwritten — on regaining focus, say. */
  const flushDrafts = useCallback(() => {
    for (const [threadId, pending] of pendingDrafts.current) {
      if (!pending.saved) void flushDraft(threadId);
    }
  }, [flushDraft]);

  /**
   * Save a thread's draft reply.
   *
   * Into state first, disk second. The composer is keyed on the thread, so it
   * unmounts the moment you step to the next comment — state is the only
   * place the text survives that, and it's what the box is refilled from when
   * you come back. Waiting for the store instead meant a draft that had been
   * written but not yet re-read came back as an empty box.
   *
   * No session refresh: one would echo the text back into a box you're still
   * typing in.
   */
  const saveDraft = useCallback(
    (threadId: string, text: string | null) => {
      if (!responseKey) return;
      pendingDrafts.current.set(threadId, { key: responseKey, text });
      setSession((current) =>
        current
          ? withDrafts(current, pendingDrafts.current, responseKey)
          : current,
      );
      void flushDraft(threadId);
    },
    [flushDraft, responseKey],
  );

  // Coming back to the window is the moment to retry anything the store never
  // confirmed — Backstory's own server may simply have been restarting when
  // you typed it.
  useEffect(() => {
    window.addEventListener("focus", flushDrafts);
    return () => window.removeEventListener("focus", flushDrafts);
  }, [flushDrafts]);

  // And once a draft is stuck, keep knocking on its own. The likeliest reason
  // is a server that went away, which usually comes back — and the person who
  // typed the reply shouldn't have to do anything to get it saved.
  useEffect(() => {
    if (!draftNotice) return;
    const timer = setInterval(flushDrafts, 15_000);
    return () => clearInterval(timer);
  }, [draftNotice, flushDrafts]);

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
      // Fire-and-forget, and keepalive so a reload in the same instant as the
      // click can't cancel a tick the screen has already shown as saved.
      void writeResponse(threadId, { done }, { keepalive: true });
    },
    [writeResponse],
  );

  /**
   * Link the change on screen to a comment, or clear the link. Refreshes,
   * because the server computes the patch-id that lets the link survive a
   * rebase and the client has no way to know it.
   */
  const linkCommit = useCallback(
    async (threadId: string, sha: string | null, unlink?: string) => {
      const { ok, error } = await writeResponse(
        threadId,
        unlink ? { unlink } : { sha },
      );
      // A pasted sha can simply not exist. Saying so beats a click that looks
      // like it worked and leaves the row unchanged.
      if (!ok) {
        setLinkNotice(error ?? "That didn't reach Backstory — try again.");
        return;
      }
      setLinkNotice(null);
      void loadSession(repoPath, { background: true });
    },
    [writeResponse, repoPath, loadSession],
  );

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
    if (!diff || diff.rev !== rev) return null;
    if (rev === WORKING_REV || rev === BRANCH_REV) return rev;
    if (commitForRev && /^[0-9a-f]{40}$/.test(commitForRev.sha))
      return commitForRev.sha;
    return /^[0-9a-f]{40}$/.test(rev) ? rev : null;
  }, [diff, rev, commitForRev]);

  // j/k move through a list the way they would in a TUI, the open tab's:
  // flow steps on Story, comments on Comments, changes on Files changed.
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

      if (tab === "comments") {
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
        const ids = threads.map((t) => t.id);
        const at = commentId ? ids.indexOf(commentId) : -1;
        if (at === -1) return;
        const step = event.key === "j" ? at + 1 : at - 1;
        if (step < 0 || step >= ids.length) return;

        event.preventDefault();
        selectComment(ids[step]);
        return;
      }
      if (event.key === "x") return;

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
  }, [session, rev, threads, commentId, toggleDone, selectComment, tab]);

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
        <div className="flex items-start">
          {/* No comments, no checklist. A branch nobody has reviewed yet —
              often work an agent just wrote, which you're reading before it
              goes anywhere — would give up the spine to say "no review
              comments". The story is what you came for; it gets the window. */}
          {hasComments && (
            <TickSpine
              threads={threads}
              selectedId={commentId}
              onSelect={(thread) => selectComment(thread.id)}
            />
          )}

          <main className="min-w-0 flex-1 pb-16">
            {/* Below lg the spine can't sit beside the content, and the old
                300px list simply vanished at this width — leaving the checklist
                unreachable. Same squares, laid out sideways. */}
            {hasComments && (
              <TickStrip
                threads={threads}
                selectedId={commentId}
                onSelect={(thread) => selectComment(thread.id)}
              />
            )}
            <div className="mx-auto w-full max-w-[1280px] space-y-3 p-4 pt-3">
              {session.github.pr && <PrTitle pr={session.github.pr} />}

              {revNotice && (
                <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                  <AlertIcon
                    size={13}
                    className="mt-0.5 shrink-0 text-[var(--attention)]"
                  />
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
                  {session.github.connect && (
                    <>
                      {" "}
                      <ConnectGitHubLink />
                    </>
                  )}
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

              {/* Not dismissible, and it stays until a write actually lands:
                the whole point is that you find out your words are only in
                this window before you close it. */}
              {draftNotice && (
                <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                  <AlertIcon
                    size={13}
                    className="mt-0.5 shrink-0 text-[var(--attention)]"
                  />
                  <span className="flex-1">
                    A draft reply hasn&apos;t reached Backstory — it&apos;s
                    still here and still being retried, but copy it somewhere
                    safe before closing this window.
                  </span>
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

              <ChangeHeader
                session={session}
                rev={rev}
                onRevChange={pickRev}
                commit={commitForRev}
                diff={diff}
                threads={threads}
                thread={selectedThread}
                pushed={revIsPushed}
              />

              <Tabs
                tab={tab}
                onTab={setTab}
                fileCount={diff && diff.rev === rev ? diff.files.length : null}
                threads={threads}
              />

              <WithReview root={session.repo.root} tick={reviewTick}>
                {({ notes, review, outbox }) => (
                  <>
                    {visited.has("story") && (
                      <div hidden={tab !== "story"}>
                        <Story
                          repo={repoPath}
                          rev={rev}
                          map={map}
                          data={dataModel}
                          entityNotes={entityNotes}
                          onModelChange={onModelChange}
                          mapHighlight={mapHighlight}
                          onOpenFile={openFile}
                          flows={flows}
                          diff={diff && diff.rev === rev ? diff : null}
                          onShowFiles={() => setTab("files")}
                          onShowYourself={showYourself}
                          target={storyTarget}
                          onShowInFiles={showInFiles}
                          navRef={flowNavRef}
                          components={componentInfo}
                          dataFields={dataFields}
                          flowNotes={flowNotes}
                        />
                      </div>
                    )}
                    {visited.has("files") && (
                      <div hidden={tab !== "files"}>
                        <FilesChanged
                          diff={diff}
                          loading={diffLoading}
                          error={diffError}
                          threads={threads}
                          repo={session.repo}
                          commit={commitForRev}
                          focusedThreadId={focusedThreadId}
                          notes={noteRev ? notes : null}
                          noteRev={noteRev}
                          fileComponents={map?.fileComponents ?? null}
                          marks={marks}
                          jump={filesJump}
                          onJumped={clearFilesJump}
                          filterAsk={filesFilter}
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
                          onRevChange={pickRev}
                        />
                      </div>
                    )}
                  </>
                )}
              </WithReview>
            </div>
          </main>
        </div>
      ) : null}
    </div>
  );
}
