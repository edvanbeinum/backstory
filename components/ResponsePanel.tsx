"use client";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { CommitPicker } from "./CommitPicker";
import { AlertIcon, CheckIcon, LinkIcon } from "./icons";
import { ReplyComposer } from "./ReplyComposer";
import { TickButton } from "./Tick";

/**
 * Your response to one comment: the tick, the draft reply, and optionally the
 * commit that answers it.
 *
 * The three are independent on purpose. Linking a commit doesn't tick, and
 * neither does writing a reply — differ used to treat both as "handled",
 * which meant the checklist was recording bookkeeping rather than your
 * judgement. Here the tick is yours alone, and it's the widest control in the
 * column so it reads that way.
 */
export function ResponsePanel({
  thread,
  repo,
  pr,
  commit,
  commitCandidates,
  onToggleDone,
  onLinkCommit,
  onDraftChange,
}: {
  thread: ReviewThread;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  /** The change currently open in the diff column, offered as a link target. */
  commit: CommitSummary | null;
  commitCandidates?: CommitSummary[];
  onToggleDone: (threadId: string, done: boolean) => void;
  onLinkCommit: (threadId: string, sha: string | null) => void;
  onDraftChange?: (threadId: string, text: string | null) => void;
}) {
  const { response } = thread;
  const threadUrl = thread.comments[0]?.url ?? null;

  return (
    <div className="space-y-2">
      <CommitLink
        thread={thread}
        commit={commit}
        candidates={commitCandidates ?? []}
        onLink={onLinkCommit}
      />

      {response.commit?.missing && (
        <StaleLink
          shortSha={response.commit.shortSha}
          canLinkHere={Boolean(commit)}
          onLinkHere={() => commit && onLinkCommit(thread.id, commit.sha)}
          onClear={() => onLinkCommit(thread.id, null)}
        />
      )}

      <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
        <p className="border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Your response
        </p>

        <ReplyComposer
          repo={repo}
          pr={pr}
          commit={commit}
          threadUrl={threadUrl}
          linkedSha={response.commit?.sha ?? null}
          linkedShaMissing={response.commit?.missing}
          linkedShaHealed={response.commit?.healed}
          draft={response.reply}
          onDraftChange={
            onDraftChange ? (text) => onDraftChange(thread.id, text) : undefined
          }
        />
      </div>

      <TickButton
        done={response.done}
        doneAt={response.doneAt}
        onToggle={(next) => onToggleDone(thread.id, next)}
      />
    </div>
  );
}

/**
 * The linked commit was rebased away.
 *
 * Attention, never danger: the work is done and the tick stays. It's the
 * pointer that rotted, and the count doesn't move. Re-linking is offered and
 * never demanded — hence the third option, which is the honest one most of
 * the time.
 */
function StaleLink({
  shortSha,
  canLinkHere,
  onLinkHere,
  onClear,
}: {
  shortSha: string;
  canLinkHere: boolean;
  onLinkHere: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-md border border-[var(--attention)] bg-[var(--canvas)] p-3">
      <p className="flex items-start gap-2 text-[12px]">
        <AlertIcon size={13} className="mt-0.5 shrink-0 text-[var(--attention)]" />
        <span>
          <span className="mono">{shortSha}</span> is gone — squashed, amended,
          or rebased through a conflict. Still handled; only the link needs
          replacing.
        </span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-[21px]">
        <button
          type="button"
          disabled={!canLinkHere}
          onClick={onLinkHere}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-2 py-1 text-[11px] font-medium hover:border-[var(--fg-muted)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LinkIcon size={11} /> Link the commit on screen
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] text-[var(--accent)] hover:underline"
        >
          or leave it
        </button>
      </div>
    </div>
  );
}

/**
 * Linking the commit that answers a comment.
 *
 * This used to live as a "Pin to…" link inside the composer's status line,
 * which was wrong twice over: it called the thing a pin when every other
 * surface calls it a link, and the one-click version only appeared when the
 * diff column happened to already be showing a real commit. On a branch you'd
 * just pushed the panel would say "reply anyway, or link one" and then offer
 * no way to link one.
 *
 * So it's a row of its own, always present, with the change on screen offered
 * first because that's usually the one you just read.
 */
function CommitLink({
  thread,
  commit,
  candidates,
  onLink,
}: {
  thread: ReviewThread;
  commit: CommitSummary | null;
  candidates: CommitSummary[];
  onLink: (threadId: string, sha: string | null) => void;
}) {
  const linked = thread.response.commit;

  // Uncommitted work and the combined branch diff have no sha to point at.
  const onScreen =
    commit && commit.sha !== WORKING_REV && commit.sha !== BRANCH_REV
      ? commit
      : null;

  // A sha alone doesn't tell you whether you linked the right thing. The
  // subject does, so find it — a sha pasted from outside the branch's recent
  // commits won't be here, and then the sha is all there is to show.
  const linkedDetail =
    linked && (candidates.find((c) => c.sha === linked.sha) ?? null);

  return (
    <section className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <p className="border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
        The change that answers it
      </p>

      {linked && !linked.missing ? (
        <div className="p-3">
          <div className="flex items-baseline gap-2">
            <CheckIcon size={13} className="shrink-0 text-[var(--handled)]" />
            <span className="mono text-[13px] font-semibold">
              {linked.shortSha}
            </span>
            {linked.healed && (
              <span className="text-[11px] text-[var(--fg-subtle)]">
                re-matched after a rebase
              </span>
            )}
          </div>
          {linkedDetail && (
            <p className="mt-1 pl-[21px] text-[12px] text-[var(--fg)]">
              {linkedDetail.subject}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[21px]">
            <CommitPicker
              label="Change…"
              candidates={candidates}
              selected={linked.sha}
              onPick={(sha) => onLink(thread.id, sha)}
              variant="button"
              align="left"
            />
            <button
              type="button"
              onClick={() => onLink(thread.id, null)}
              className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[12px] font-medium text-[var(--fg-muted)] hover:border-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Unlink
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3">
          <p className="text-[12px] text-[var(--fg-muted)]">
            {linked?.missing
              ? "Its commit was rebased away — pick the change that answers it now."
              : "Nothing linked yet. Pick the change that answers this comment."}
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {onScreen && (
              <button
                type="button"
                onClick={() => onLink(thread.id, onScreen.sha)}
                title={onScreen.subject}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent-subtle)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--accent)] hover:bg-[var(--canvas)]"
              >
                <LinkIcon size={12} className="shrink-0" />
                Link <span className="mono">{onScreen.shortSha}</span>
                <span className="min-w-0 truncate font-normal opacity-80">
                  — {onScreen.subject}
                </span>
              </button>
            )}
            <CommitPicker
              label={onScreen ? "Another commit…" : "Choose a commit…"}
              candidates={candidates}
              selected={null}
              onPick={(sha) => onLink(thread.id, sha)}
              variant="button"
              align="left"
            />
          </div>
        </div>
      )}
    </section>
  );
}
