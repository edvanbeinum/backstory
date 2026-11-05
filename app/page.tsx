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
import { draftNote } from "@/lib/feedback";
import { findings as designQuestions } from "@/lib/findings";
import { useFlows } from "@/components/useFlows";
import { useNotes, type NotesApi } from "@/components/useNotes";
import { useOutbox, type OutboxApi } from "@/components/useOutbox";
import { useReview, type ReviewApi } from "@/components/useReview";
import { stepsAt, type FlowRow, type StepAt } from "@/lib/flows/rows";
import { AlertIcon } from "@/components/icons";
import { Inbox } from "@/components/Inbox";
import { RepoBrowser } from "@/components/RepoBrowser";
import { PrTitle } from "@/components/PrTitle";
import { ViewProvider } from "@/components/ViewContext";
import { pushedState } from "@/lib/pushed";
import { RepoBar } from "@/components/RepoBar";
import { useInboxRepos } from "@/components/useInboxRepos";
import { useRecents } from "@/components/useRecents";
import { useSession } from "@/components/useSession";
import { useUrlState } from "@/components/useUrlState";
import { useViewData } from "@/components/useViewData";
import { BRANCH_REV, STACK_REV, WORKING_REV } from "@/lib/constants";
import { viewKey, type Tab } from "@/lib/url";
import type { CommitSummary, Note } from "@/lib/types";

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
  const {
    repo: repoPath,
    ref,
    rev,
    tab,
    comment: commentId,
    setup,
    ready,
    setRev,
    setTab,
    setComment: setCommentId,
    setSetup,
    open,
    toInbox,
  } = useUrlState();
  const recents = useRecents();
  const inboxRepos = useInboxRepos();
  const { touch: touchRecent, remove: removeRecent } = recents;
  const rememberRoot = inboxRepos.remember;
  // Every repo that loads earns a spot in the dropdown, with its branch as
  // context, and in the inbox.
  const onOpened = useCallback(
    (root: string, branch: string | null) => {
      touchRecent(root, branch);
      rememberRoot(root);
    },
    [touchRecent, rememberRoot],
  );
  const openSession = useSession({
    repo: repoPath,
    ref,
    ready,
    setRev,
    setComment: setCommentId,
    onOpened,
    onGone: removeRecent,
  });
  const { session, shown, ticks, reopen, pin } = openSession;
  const view = useViewData({
    repo: repoPath,
    ready,
    shown,
    rev,
    session,
    ticks,
  });
  const {
    viewId,
    workingDiffKey,
    diff,
    diffLoading,
    diffError,
    diffIsCurrent,
    map,
    data: dataModel,
  } = view;

  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  /** Focus asked for from outside Comments, which scrolls the thread into view. */
  const [focusAsk, setFocusAsk] = useState<{ id: string; at: number } | null>(
    null,
  );
  // A `?comment=` link asks for its thread once the URL is read. Comments
  // scrolls on each new ask, and a render can't read the clock, so this one
  // is at 0.
  const [urlRead, setUrlRead] = useState(false);
  if (ready && !urlRead) {
    setUrlRead(true);
    if (commentId) setFocusAsk({ id: commentId, at: 0 });
  }
  const flowNavRef = useRef<((delta: number) => boolean) | null>(null);

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
    if (rev === STACK_REV) {
      return {
        ...WORKING_COMMIT,
        sha: STACK_REV,
        shortSha: STACK_REV,
        subject: `Whole stack ${session?.stackDiff?.label ?? "vs base"}`,
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
    `${ticks.flows}:${workingDiffKey}`,
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
  /** The filter Files changed opens with, from "3 changes no flow reaches". */
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

  const showInFiles = useCallback(
    (row: FlowRow) => {
      setFilesJump({
        path: row.step.file,
        side: row.side,
        line: row.step.line,
        at: Date.now(),
      });
      setTab("files");
    },
    [setTab],
  );

  const clearFilesJump = useCallback(() => setFilesJump(null), []);

  // Clear a target once a card has opened it, or a regenerate's remount would
  // open it again and scroll the window from behind another tab.
  const clearStoryTarget = useCallback(
    (at: number) => setStoryTarget((t) => (t?.at === at ? null : t)),
    [],
  );

  const openFile = useCallback(
    (path: string) => {
      setFilesJump({ path, at: Date.now() });
      setTab("files");
    },
    [setTab],
  );

  const openStep = useCallback(
    (step: Omit<StoryTarget, "at">) => {
      setStoryTarget({ flow: step.flow, row: step.row, at: Date.now() });
      setTab("story");
    },
    [setTab],
  );

  const showOnMap = useCallback(
    (name: string) => {
      setMapHighlight({ name, at: Date.now() });
      setTab("story");
    },
    [setTab],
  );

  const showYourself = useCallback(() => {
    setFilesFilter({ filter: "yourself", at: Date.now() });
    setTab("files");
    window.scrollTo({ top: 0 });
  }, [setTab]);

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
  const selectComment = useCallback(
    (id: string) => {
      setCommentId(id);
      setFocusedThreadId(id);
      setFocusAsk({ id, at: Date.now() });
      setTab("comments");
    },
    [setCommentId, setTab],
  );

  /** Open a checkout, optionally on a branch other than the one it has checked out. */
  const selectRepo = useCallback(
    (path: string, branch?: string | null) => {
      const trimmed = path.trim();
      if (trimmed !== repoPath || (branch ?? null) !== ref) reopen();
      open(trimmed, branch ?? null);
    },
    [repoPath, ref, reopen, open],
  );

  /** A change picked above the tabs: it opens on Story, as every view does. */
  const pickRev = useCallback(
    (next: string) => {
      pin(next);
      setRev(next);
      setTab("story");
    },
    [pin, setRev, setTab],
  );

  // The change on screen as a note records it: a commit by its full sha,
  // which is what stays comparable across views. Null until the diff showing
  // is this change's — for a moment after switching it's still the last one,
  // and a note left then would be filed against the wrong change.
  const noteRev = useMemo(() => {
    if (!diffIsCurrent) return null;
    if (rev === WORKING_REV || rev === BRANCH_REV || rev === STACK_REV)
      return rev;
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
    [noteRev, pickRev, shown, setTab],
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

      // On Story, j/k walk the steps of the topmost open flow; with no flow
      // open, they move changes as Files changed does.
      const delta = event.key === "j" ? 1 : -1;
      if (tab === "story" && flowNavRef.current?.(delta)) {
        event.preventDefault();
        return;
      }

      const order = [
        ...(session.branchDiff ? [BRANCH_REV] : []),
        ...(session.stackDiff ? [STACK_REV] : []),
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
  }, [session, rev, threads, commentId, selectComment, tab, setRev]);

  return (
    <ClaudeCodeGate>
      <div className="min-h-screen">
        {repoPath && (
          <RepoBar
            repoPath={repoPath}
            onRepoPathChange={selectRepo}
            session={session}
            loading={openSession.loading || diffLoading}
            onRefresh={() => openSession.reload(true)}
            recents={recents.list}
            onRemoveRecent={removeRecent}
            onBackToInbox={toInbox}
          />
        )}

        {!repoPath ? (
          <>
            <Inbox
              roots={inboxRepos.repos}
              onOpen={selectRepo}
              onAdd={rememberRoot}
              onBrowse={() => setBrowsing(true)}
              onForget={inboxRepos.forget}
              setupAsked={setup}
              onSetupDone={() => setSetup(false)}
            />
            {browsing && (
              <RepoBrowser
                currentRepo={inboxRepos.repos[0] ?? null}
                onPick={(path) => {
                  setBrowsing(false);
                  selectRepo(path);
                }}
                onClose={() => setBrowsing(false)}
              />
            )}
          </>
        ) : openSession.error ? (
          <div className="mx-auto max-w-3xl p-6">
            <div className="flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--canvas)] p-4 text-[13px]">
              <AlertIcon className="mt-0.5 shrink-0 text-[var(--danger)]" />
              <span>{openSession.error}</span>
            </div>
          </div>
        ) : session ? (
          <ViewProvider value={shown}>
            <div className="flex items-start">
              <main className="min-w-0 flex-1 pb-16">
                <div className="mx-auto w-full max-w-[1280px] space-y-3 p-4 pt-3">
                  {session.github.pr && <PrTitle pr={session.github.pr} />}

                  {openSession.revNotice && (
                    <p className="flex items-start gap-2 rounded-md border border-[var(--attention)] bg-[var(--canvas)] px-3 py-2 text-[12px]">
                      <AlertIcon
                        size={13}
                        className="mt-0.5 shrink-0 text-[var(--attention)]"
                      />
                      <span className="flex-1">
                        <span className="mono">{openSession.revNotice}</span>{" "}
                        isn&apos;t waiting to be pushed any more — it may
                        already be on GitHub. Showing the latest instead.
                      </span>
                      <button
                        type="button"
                        onClick={openSession.dismissNotice}
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
                    thread={selectedThread}
                    pushed={revIsPushed}
                    onFetched={() => openSession.reload(true)}
                  />

                  <Tabs
                    tab={tab}
                    onTab={setTab}
                    fileCount={
                      diffIsCurrent ? (diff?.files.length ?? null) : null
                    }
                    threads={threads}
                  />

                  <WithReview root={session.repo.root} tick={ticks.review}>
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
                              onModelChange={openSession.bumpModel}
                              mapHighlight={mapHighlight}
                              onShowOnMap={showOnMap}
                              onOpenFile={openFile}
                              flows={flows}
                              diff={diffIsCurrent ? diff : null}
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
                              onNote={
                                noteRev
                                  ? (body) =>
                                      notes.save(
                                        draftNote({
                                          rev: noteRev,
                                          path: null,
                                          side: "new",
                                          line: null,
                                          quote: null,
                                          body,
                                        }),
                                      )
                                  : null
                              }
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
                              jump={filesJump}
                              onJumped={clearFilesJump}
                              filterAsk={filesFilter}
                              onShowOnMap={showOnMap}
                              commentNumbers={commentNumbers}
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
                                openStep({
                                  flow: at.flow - 1,
                                  row: at.row.key,
                                })
                              }
                              pr={session.github.pr}
                            />
                          </div>
                        )}

                        {/* Pinned to the bottom of the window on every tab: an
                        agent waiting on review must never be invisible, and
                        notes written in Files changed are sent from anywhere. */}
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
