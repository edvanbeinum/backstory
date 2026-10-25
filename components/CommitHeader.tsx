"use client";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { CommitSummary, DiffResponse } from "@/lib/types";
import { FileDiffIcon, GitCommitIcon } from "./icons";
import { Badge, RelativeTime } from "./ui";

/**
 * The commit message, shown the way GitHub shows it above a commit's diff:
 * subject in bold, body as preformatted text below. Nothing for uncommitted
 * work, which has no message and which the view's picker already names.
 */
export function CommitHeader({
  commit,
  diff,
  pushed = false,
  base = null,
}: {
  commit: CommitSummary | null;
  diff: DiffResponse | null;
  /** Below the push boundary — already on the remote */
  pushed?: boolean;
  /** What All changes is diffed against, as "vs main" */
  base?: string | null;
}) {
  if (!commit || commit.sha === WORKING_REV) return null;

  const isBranch = commit.sha === BRANCH_REV;
  const fileCount = diff?.files.length ?? 0;

  return (
    <section className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <div className="border-b border-[var(--border-muted)] px-4 py-3">
        <div className="mb-1 flex items-start gap-2">
          {isBranch ? (
            <FileDiffIcon size={16} className="mt-1 text-[var(--accent)]" />
          ) : (
            <GitCommitIcon size={16} className="mt-1 text-[var(--fg-muted)]" />
          )}
          <h1 className="flex-1 text-[16px] font-semibold leading-6">
            {commit.subject}
          </h1>
        </div>

        {commit.body && (
          <pre className="mono mt-2 whitespace-pre-wrap text-[12px] leading-5 text-[var(--fg-muted)]">
            {commit.body}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--canvas-subtle)] px-4 py-2 text-[12px] text-[var(--fg-muted)]">
        {isBranch ? (
          <span>
            Everything{base && ` ${base}`}: what the pull request will contain
            after you push. Uncommitted work not included.
          </span>
        ) : (
          <>
            <span>
              <span className="font-medium text-[var(--fg)]">
                {commit.authorName}
              </span>{" "}
              committed <RelativeTime iso={commit.date} />
            </span>
            <span className="mono rounded bg-[var(--canvas)] px-1.5 py-0.5 text-[11px]">
              {commit.shortSha}
            </span>
            {pushed && <Badge>already pushed</Badge>}
          </>
        )}

        <span className="flex-1" />

        {diff && (
          <span className="mono">
            {fileCount} {fileCount === 1 ? "file" : "files"}{" "}
            <span className="text-[var(--success)]">+{diff.additions}</span>{" "}
            <span className="text-[var(--danger)]">−{diff.deletions}</span>
          </span>
        )}
      </div>
    </section>
  );
}
