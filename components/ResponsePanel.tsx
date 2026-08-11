"use client";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewThread,
} from "@/lib/types";
import { CommitPicker } from "./CommitPicker";
import { AlertIcon, LinkIcon, XIcon } from "./icons";
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

        <CommitLink
          thread={thread}
          commit={commit}
          candidates={commitCandidates ?? []}
          onLink={onLinkCommit}
        />

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

  if (linked && !linked.missing) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-muted)] px-3 py-2 text-[11px]">
        <LinkIcon size={11} className="text-[var(--handled)]" />
        <span className="text-[var(--fg-muted)]">Answered by</span>
        <span className="mono font-semibold">{linked.shortSha}</span>
        {linked.healed && (
          <span className="text-[var(--fg-subtle)]">· re-matched after a rebase</span>
        )}
        <span className="flex-1" />
        <CommitPicker
          label="Change…"
          candidates={candidates}
          selected={linked.sha}
          onPick={(sha) => onLink(thread.id, sha)}
        />
        <button
          type="button"
          onClick={() => onLink(thread.id, null)}
          className="inline-flex items-center gap-0.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
          title="Unlink"
        >
          <XIcon size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-muted)] px-3 py-2 text-[11px]">
      <LinkIcon size={11} className="text-[var(--fg-subtle)]" />
      <span className="text-[var(--fg-muted)]">
        {linked?.missing ? "Link needs replacing" : "No commit linked"}
      </span>
      <span className="flex-1" />
      {onScreen && (
        <button
          type="button"
          onClick={() => onLink(thread.id, onScreen.sha)}
          className="inline-flex items-center gap-1 rounded border border-[var(--accent)] px-1.5 py-[1px] font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)]"
          title={onScreen.subject}
        >
          Link <span className="mono">{onScreen.shortSha}</span>
          <span className="text-[var(--fg-muted)]">on screen</span>
        </button>
      )}
      <CommitPicker
        label={onScreen ? "or pick…" : "Link a commit…"}
        candidates={candidates}
        selected={null}
        onPick={(sha) => onLink(thread.id, sha)}
      />
    </div>
  );
}
