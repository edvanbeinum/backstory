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
  onLinkCommit: (
    threadId: string,
    sha: string | null,
    unlink?: string,
  ) => void;
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

      <div className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
        <p className="border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          Your response
        </p>

        <ReplyComposer
          repo={repo}
          pr={pr}
          commit={commit}
          threadUrl={threadUrl}
          linkedShas={response.commits.filter((c) => !c.missing).map((c) => c.sha)}
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



function CommitLink({
  thread,
  commit,
  candidates,
  onLink,
}: {
  thread: ReviewThread;
  commit: CommitSummary | null;
  candidates: CommitSummary[];
  onLink: (threadId: string, sha: string | null, unlink?: string) => void;
}) {
  const linked = thread.response.commits;

  // Uncommitted work and the combined branch diff have no sha to point at.
  const onScreen =
    commit && commit.sha !== WORKING_REV && commit.sha !== BRANCH_REV
      ? commit
      : null;
  const alreadyLinked =
    onScreen !== null && linked.some((c) => c.sha === onScreen.sha);

  const subjectFor = (sha: string) =>
    candidates.find((c) => c.sha === sha)?.subject ?? null;

  return (
    <section className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <p className="border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
        {linked.length > 1
          ? "The changes that answer it"
          : "The change that answers it"}
      </p>

      {linked.length > 0 && (
        <ul>
          {linked.map((entry) => (
            <li
              key={entry.sha}
              className="flex items-start gap-2 border-b border-[var(--border-muted)] px-3 py-2.5"
            >
              {entry.missing ? (
                <AlertIcon
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--attention)]"
                />
              ) : (
                <LinkIcon
                  size={13}
                  className="mt-0.5 shrink-0 text-[var(--fg-muted)]"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="mono text-[13px] font-semibold">
                  {entry.shortSha}
                </span>
                {entry.healed && (
                  <span className="ml-2 text-[11px] text-[var(--fg-subtle)]">
                    re-matched after a rebase
                  </span>
                )}
                {entry.missing ? (
                  <span className="mt-0.5 block text-[12px] text-[var(--attention)]">
                    Gone — squashed, amended, or rebased through a conflict.
                    Still handled; only the link needs replacing.
                  </span>
                ) : (
                  subjectFor(entry.sha) && (
                    <span className="mt-0.5 block text-[12px] text-[var(--fg)]">
                      {subjectFor(entry.sha)}
                    </span>
                  )
                )}
              </span>
              <button
                type="button"
                onClick={() => onLink(thread.id, null, entry.sha)}
                title={`Unlink ${entry.shortSha}`}
                aria-label={`Unlink ${entry.shortSha}`}
                className="shrink-0 rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)]"
              >
                <XIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="p-3">
        {linked.length === 0 && (
          <p className="mb-2.5 text-[12px] text-[var(--fg-muted)]">
            Nothing linked yet. Pick the change that answers this comment.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {onScreen && !alreadyLinked && (
            <button
              type="button"
              onClick={() => onLink(thread.id, onScreen.sha)}
              title={onScreen.subject}
              // Deliberately not the accent-subtle chip: that's what a
              // *selected* thing looks like everywhere else in differ, so an
              // unlinked comment was wearing the linked state's clothes.
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[#1f883d] bg-[#1f883d] px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-[#1a7f37]"
            >
              <LinkIcon size={12} className="shrink-0" />
              Link <span className="mono">{onScreen.shortSha}</span>
              <span className="min-w-0 truncate font-normal opacity-85">
                — {onScreen.subject}
              </span>
            </button>
          )}
          <CommitPicker
            label={
              linked.length > 0 ? "Link another…" : "Choose a commit…"
            }
            candidates={candidates}
            selected={null}
            onPick={(sha) => onLink(thread.id, sha)}
            variant="button"
            align="left"
          />
        </div>
      </div>
    </section>
  );
}
