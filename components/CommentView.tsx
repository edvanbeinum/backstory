"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type {
  ApiError,
  CommitSummary,
  DiffResponse,
  SessionResponse,
  ReviewThread,
} from "@/lib/types";
import { DiffFile } from "./DiffFile";
import {
  AlertIcon,
  FileDiffIcon,
  GitCommitIcon,
  PencilIcon,
} from "./icons";
import { ReviewThreadCard } from "./ReviewThreadCard";
import { Spinner } from "./ui";

export interface Source {
  /** The rev to diff: a sha, WORKING_REV, or BRANCH_REV */
  rev: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

/**
 * The sources that could answer a comment, best first.
 *
 * A comment is answered by uncommitted work, by a commit, or by nothing yet.
 * Uncommitted leads when it touches the comment's file, because that's where
 * you are when you glance at a comment mid-fix — the case the commit-only
 * view couldn't serve at all.
 */
export function sourcesFor(
  thread: ReviewThread,
  session: SessionResponse,
): Source[] {
  const sources: Source[] = [];
  const path = thread.path;

  if (path && session.working.changedPaths.includes(path)) {
    sources.push({
      rev: WORKING_REV,
      label: "Uncommitted",
      hint: "your working-tree changes to this file, not yet committed",
      icon: <PencilIcon size={12} />,
    });
  }

  const linked =
    (thread.pinnedShaMissing ? null : thread.pinnedSha) ??
    thread.addressedBySha ??
    null;
  if (linked) {
    const commit =
      session.commits.find((c) => c.sha === linked) ??
      session.history.find((c) => c.sha === linked);
    sources.push({
      rev: linked,
      label: linked.slice(0, 7),
      hint: thread.pinnedSha
        ? `pinned: ${commit?.subject ?? "commit"}`
        : `last commit to touch this file: ${commit?.subject ?? "commit"}`,
      icon: <GitCommitIcon size={12} />,
    });
  }

  if (session.branchDiff) {
    sources.push({
      rev: BRANCH_REV,
      label: "All changes",
      hint: `everything ${session.branchDiff.label}`,
      icon: <FileDiffIcon size={12} />,
    });
  }

  return sources;
}

/**
 * The comment as the subject of the page: the thread and its reply box on
 * top, then the change that answers it — scoped to the comment's file, since
 * that is the only file this comment is about.
 */
export function CommentView({
  thread,
  session,
  repoPath,
  srcOverride,
  onSrcChange,
  focusedThreadId,
  onPin,
  pinCandidates,
  onDraftChange,
}: {
  thread: ReviewThread;
  session: SessionResponse;
  repoPath: string;
  srcOverride: string | null;
  onSrcChange: (rev: string | null) => void;
  focusedThreadId: string | null;
  onPin?: (threadId: string, sha: string | null) => void;
  pinCandidates?: CommitSummary[];
  onDraftChange?: (threadId: string, text: string | null) => void;
}) {
  const sources = useMemo(
    () => sourcesFor(thread, session),
    [thread, session],
  );

  // An override only holds while it's still one of the offered sources —
  // committing your work makes the Uncommitted chip disappear, and the view
  // should fall back rather than sit on a dead selection.
  const active =
    sources.find((s) => s.rev === srcOverride) ?? sources[0] ?? null;

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = thread.path;

  useEffect(() => {
    if (!active || !path) {
      setDiff(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ repo: repoPath, rev: active.rev });
    params.append("path", path);

    fetch(`/api/diff?${params}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error((data as ApiError).error);
        if (!cancelled) setDiff(data as DiffResponse);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, active, path]);

  const commitForSource = useCallback((): CommitSummary | null => {
    if (!active) return null;
    if (active.rev === WORKING_REV || active.rev === BRANCH_REV) {
      // Neither has a sha, so neither can produce a reply link. The composer
      // already explains that; don't invent one here.
      return null;
    }
    return (
      session.commits.find((c) => c.sha === active.rev) ??
      session.history.find((c) => c.sha === active.rev) ??
      null
    );
  }, [active, session]);

  return (
    <div className="space-y-3">
      <ReviewThreadCard
        thread={thread}
        repo={session.repo}
        pr={session.github.pr}
        commit={commitForSource()}
        showContext
        defaultCollapsed={false}
        onPin={onPin}
        pinCandidates={pinCandidates}
        onDraftChange={onDraftChange}
      />

      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[var(--fg-muted)]">
            Answered by
          </span>
          {sources.map((source) => (
            <button
              key={source.rev}
              type="button"
              title={source.hint}
              onClick={() =>
                onSrcChange(source.rev === sources[0]?.rev ? null : source.rev)
              }
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
                active?.rev === source.rev
                  ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]"
              }`}
            >
              {source.icon}
              {source.label}
            </button>
          ))}
        </div>
      )}

      {!path ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-6 text-center text-[13px] text-[var(--fg-muted)]">
          This is a general pull request comment, not attached to a file.
        </p>
      ) : sources.length === 0 ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-6 text-center text-[13px] text-[var(--fg-muted)]">
          Nothing answers this comment yet — no commit touches{" "}
          <span className="mono">{path.split("/").pop()}</span> and there are
          no uncommitted changes to it.
        </p>
      ) : error ? (
        <p className="flex items-start gap-2 rounded-md border border-[var(--danger)] bg-[var(--canvas)] p-4 text-[13px]">
          <AlertIcon className="mt-0.5 shrink-0 text-[var(--danger)]" />
          {error}
        </p>
      ) : loading && !diff ? (
        <p className="flex items-center justify-center gap-2 py-10 text-[var(--fg-muted)]">
          <Spinner /> Loading the change…
        </p>
      ) : diff && diff.files.length > 0 ? (
        diff.files.map((file) => (
          <DiffFile
            key={`${file.oldPath}-${file.newPath}`}
            file={file}
            threads={[thread]}
            repo={session.repo}
            pr={session.github.pr}
            commit={commitForSource()}
            focusedThreadId={focusedThreadId}
            onPin={onPin}
            pinCandidates={pinCandidates}
            onDraftChange={onDraftChange}
          />
        ))
      ) : (
        <p className="rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-6 text-center text-[13px] text-[var(--fg-muted)]">
          {active?.label} doesn&apos;t change{" "}
          <span className="mono">{path.split("/").pop()}</span>.
        </p>
      )}
    </div>
  );
}
