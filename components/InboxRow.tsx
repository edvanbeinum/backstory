"use client";

import type { InboxRow as Row } from "@/lib/inbox";
import { PullRequestIcon } from "./icons";
import { RelativeTime } from "./ui";

/**
 * One worktree.
 *
 * The branch leads because the branch is the identity — a folder name is just
 * what it was called when it was created, and they drift. One of yours holds
 * `feature/offline-reconcile-1477` in a directory named
 * `…feature-offline-manager-1471`. So the folder appears only when it
 * disagrees, as a footnote.
 *
 * What the branch changes against its base, and when it last moved, sit in a
 * fixed right-hand column so they line up down the page and are one glance,
 * not twenty.
 */
export function InboxRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const { changes } = row;
  // Worth saying only when the folder disagrees with the branch it holds —
  // one of these directories is named for a branch it stopped holding two
  // renames ago. A folder simply named after the repo isn't a disagreement.
  const slug = row.branch?.replace(/\//g, "-") ?? "";
  const folderDiffers =
    row.branch !== null &&
    row.worktree !== null &&
    !row.isMain &&
    !row.worktree.name.endsWith(slug);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={row.worktree?.missing}
      className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md py-3 pr-2 text-left hover:bg-[var(--canvas-subtle)] disabled:cursor-not-allowed ${
        row.worktree?.missing ? "opacity-60" : ""
      }`}
      // A stacked PR targets the branch below it, so the indent is the stack.
      style={{ paddingLeft: 8 + row.depth * 18 }}
    >
      <span className="mt-[5px] grid place-items-center">
        <StatusGlyph changed={row.changed} />
      </span>

      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={`mono text-[13px] font-semibold ${
              row.pr ? "text-[var(--fg)]" : "text-[var(--fg-muted)]"
            }`}
          >
            {row.branch ?? "(detached HEAD)"}
          </span>
          {row.pr ? <PrPill pr={row.pr} /> : <NoPrPill />}
          {row.worktree?.missing && (
            <span className="text-[11px] text-[var(--attention)]">
              registered but gone
            </span>
          )}
        </span>

        {row.pr ? (
          <>
            <span className="mt-0.5 block truncate text-[13px] text-[var(--fg)]">
              {row.pr.title}
            </span>
            {!row.worktree && (
              // Reviewable all the same — Backstory reads any ref from any
              // worktree of the repo. Worth saying only so you know why
              // there's no uncommitted work to compare against.
              <span className="mt-0.5 block text-[11px] text-[var(--fg-subtle)]">
                not checked out
                {row.depth > 0 && ` · on ${row.pr.baseRefName}`}
              </span>
            )}
          </>
        ) : (
          <span className="mt-0.5 block text-[12px] text-[var(--fg-subtle)]">
            {row.ahead === null
              ? "no upstream yet"
              : row.ahead > 0
                ? `${row.ahead} ${row.ahead === 1 ? "commit" : "commits"} ahead of upstream`
                : "up to date with upstream"}{" "}
            · no pull request yet
          </span>
        )}

        {folderDiffers && (
          <span className="mono mt-0.5 block truncate text-[11px] text-[var(--fg-subtle)]">
            ↳ in {row.worktree?.name}
          </span>
        )}
      </span>

      <span className="whitespace-nowrap pl-4 text-right text-[11px] text-[var(--fg-muted)]">
        {changes && (
          <>
            <span className="mono block text-[12px]">
              <span className="text-[var(--success)]">
                +{changes.additions}
              </span>{" "}
              <span className="text-[var(--danger)]">−{changes.deletions}</span>
            </span>
            <span className="block">
              {changes.files} {changes.files === 1 ? "file" : "files"} ·{" "}
              {changes.commits} {changes.commits === 1 ? "commit" : "commits"}
            </span>
          </>
        )}
        <span className="block text-[var(--fg-subtle)]">
          {row.lastCommitAt && <RelativeTime iso={row.lastCommitAt} />}
          {row.changed && (
            <span className="text-[var(--attention)]">
              {row.lastCommitAt && " · "}new since you looked
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function StatusGlyph({ changed }: { changed: boolean }) {
  if (!changed) {
    return (
      <svg viewBox="0 0 16 16" width={10} height={10} aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="var(--fg-subtle)"
          strokeWidth="2"
        />
      </svg>
    );
  }
  return (
    <span className="block h-2.5 w-2.5 rounded-full bg-[var(--attention)]" />
  );
}

function PrPill({ pr }: { pr: NonNullable<Row["pr"]> }) {
  const tone = pr.isDraft
    ? { bg: "var(--fg-muted)" }
    : pr.state === "OPEN"
      ? { bg: "#1f883d" }
      : pr.state === "MERGED"
        ? { bg: "var(--done)" }
        : { bg: "var(--danger)" };

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 text-[11px] font-medium leading-[19px] text-white"
      style={{ background: tone.bg }}
    >
      <PullRequestIcon size={11} />#{pr.number}{" "}
      {pr.isDraft ? "draft" : pr.state.toLowerCase()}
    </span>
  );
}

function NoPrPill() {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] px-2.5 text-[11px] font-medium leading-[17px] text-[var(--fg-muted)]">
      no PR yet
    </span>
  );
}
