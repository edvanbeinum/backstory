"use client";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { SessionResponse } from "@/lib/types";
import { FileDiffIcon, GitCommitIcon, PencilIcon } from "./icons";
import { RelativeTime } from "./ui";

export function CommitList({
  session,
  selected,
  onSelect,
  threadCountFor,
}: {
  session: SessionResponse;
  selected: string;
  onSelect: (rev: string) => void;
  threadCountFor: (rev: string) => number;
}) {
  const { commits, history, working, base, branchDiff } = session;

  return (
    <nav aria-label="Commits">
      {/* The whole branch as one diff — GitHub's "Files changed" tab, but
          before the push. Pinned above the per-commit list. */}
      {branchDiff && (
        <ul className="border-b border-[var(--border-muted)] pt-1.5">
          <Row
            selected={selected === BRANCH_REV}
            onSelect={() => onSelect(BRANCH_REV)}
            icon={<FileDiffIcon size={14} className="text-[var(--accent)]" />}
            title={`All changes ${branchDiff.label}`}
            meta={
              <>
                {branchDiff.commits}{" "}
                {branchDiff.commits === 1 ? "commit" : "commits"} ·{" "}
                {branchDiff.filesChanged}{" "}
                {branchDiff.filesChanged === 1 ? "file" : "files"} ·{" "}
                <span className="text-[var(--success)]">
                  +{branchDiff.additions}
                </span>{" "}
                <span className="text-[var(--danger)]">
                  −{branchDiff.deletions}
                </span>
              </>
            }
            threads={threadCountFor(BRANCH_REV)}
          />
        </ul>
      )}

      <h2 className="px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
        Not yet pushed
      </h2>

      <ul>
        {working.hasChanges && (
          <Row
            selected={selected === WORKING_REV}
            onSelect={() => onSelect(WORKING_REV)}
            icon={<PencilIcon size={14} className="text-[var(--attention)]" />}
            title="Uncommitted changes"
            meta={[
              working.staged && `${working.staged} staged`,
              working.unstaged && `${working.unstaged} unstaged`,
              working.untracked && `${working.untracked} untracked`,
            ]
              .filter(Boolean)
              .join(" · ")}
            threads={threadCountFor(WORKING_REV)}
          />
        )}

        {commits.map((commit) => (
          <Row
            key={commit.sha}
            selected={selected === commit.sha}
            onSelect={() => onSelect(commit.sha)}
            icon={
              <GitCommitIcon size={14} className="text-[var(--fg-muted)]" />
            }
            title={commit.subject || "(no message)"}
            meta={
              <>
                <span className="mono">{commit.shortSha}</span>
                {commit.isMerge && <span> · merge</span>}
                {commit.date && (
                  <>
                    {" · "}
                    <RelativeTime iso={commit.date} />
                  </>
                )}
              </>
            }
            threads={threadCountFor(commit.sha)}
          />
        ))}
      </ul>

      {commits.length === 0 && !working.hasChanges && (
        <p className="px-3 py-4 text-[12px] text-[var(--fg-muted)]">
          Nothing to review — your branch matches {base.ref || "its base"} and
          the working tree is clean.
        </p>
      )}

      {/* The push boundary: everything below this line is on a remote. When
          a rebase has moved the boundary off the upstream's merge base, the
          ref name would mislabel what's below, so say "already pushed". */}
      <div className="mt-1 flex items-center gap-2 px-3 py-2">
        <span className="h-px flex-1 bg-[var(--border)]" />
        <span className="mono text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">
          {base.boundarySha && base.sha && base.boundarySha !== base.sha
            ? "already pushed"
            : base.ref || "no base"}
        </span>
        <span className="h-px flex-1 bg-[var(--border)]" />
      </div>

      {history.length > 0 && (
        <ul className="opacity-75">
          {history.map((commit) => (
            <Row
              key={commit.sha}
              selected={selected === commit.sha}
              onSelect={() => onSelect(commit.sha)}
              icon={
                <GitCommitIcon size={14} className="text-[var(--fg-subtle)]" />
              }
              title={commit.subject || "(no message)"}
              meta={
                <>
                  <span className="mono">{commit.shortSha}</span>
                  {commit.isMerge && <span> · merge</span>}
                  {commit.date && (
                    <>
                      {" · "}
                      <RelativeTime iso={commit.date} />
                    </>
                  )}
                </>
              }
              threads={threadCountFor(commit.sha)}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

function Row({
  selected,
  onSelect,
  icon,
  title,
  meta,
  threads,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  meta: React.ReactNode;
  threads: number;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${
          selected
            ? "border-[var(--accent)] bg-[var(--accent-subtle)]"
            : "border-transparent hover:bg-[var(--canvas-subtle)]"
        }`}
      >
        <span className="mt-[3px] shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5">
            {title}
          </span>
          <span className="block truncate text-[11px] text-[var(--fg-muted)]">
            {meta}
          </span>
        </span>
        {threads > 0 && (
          <span
            title={`${threads} open review ${threads === 1 ? "thread lands" : "threads land"} in this diff`}
            className="mt-[2px] shrink-0 rounded-full bg-[var(--attention)] px-1.5 text-[10px] font-semibold leading-[18px] text-white"
          >
            {threads}
          </span>
        )}
      </button>
    </li>
  );
}
