"use client";

import type { InboxRow as Row } from "@/lib/inbox";
import { CheckIcon, PullRequestIcon } from "./icons";

/**
 * One worktree.
 *
 * The branch leads because the branch is the identity — a folder name is just
 * what it was called when it was created, and they drift. One of yours holds
 * `feature/offline-reconcile-1477` in a directory named
 * `…feature-offline-manager-1471`. So the folder appears only when it
 * disagrees, as a footnote.
 *
 * Progress sits in a fixed right-hand column so the counts line up down the
 * page and "what still needs me" is one glance, not twenty.
 */
export function InboxRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const progress = row.progress;
  const allHandled = progress !== null && progress.done === progress.total;
  // Worth saying only when the folder disagrees with the branch it holds —
  // one of these directories is named for a branch it stopped holding two
  // renames ago. A folder simply named after the repo isn't a disagreement.
  const slug = row.branch?.replace(/\//g, "-") ?? "";
  const folderDiffers =
    row.branch !== null && !row.isMain && !row.name.endsWith(slug);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={row.missing}
      className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-3 text-left hover:bg-[var(--canvas-subtle)] disabled:cursor-not-allowed ${
        allHandled || row.missing ? "opacity-60" : ""
      }`}
    >
      <span className="mt-[5px] grid place-items-center">
        <StatusGlyph row={row} allHandled={allHandled} />
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
          {row.missing && (
            <span className="text-[11px] text-[var(--attention)]">
              registered but gone
            </span>
          )}
        </span>

        {row.pr ? (
          <span className="mt-0.5 block truncate text-[13px] text-[var(--fg)]">
            {row.pr.title}
          </span>
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
            ↳ in {row.name}
          </span>
        )}
      </span>

      {progress && progress.total > 0 && (
        <span className="flex flex-col items-end gap-1 pl-4">
          <Meter done={progress.done} total={progress.total} />
          <span className="mono whitespace-nowrap text-[11px] text-[var(--fg-muted)]">
            {allHandled
              ? "all handled"
              : `${progress.done} of ${progress.total} handled`}
            {progress.truncated && " +"}
          </span>
        </span>
      )}
    </button>
  );
}

function StatusGlyph({ row, allHandled }: { row: Row; allHandled: boolean }) {
  if (!row.progress || row.progress.total === 0) {
    // Nothing to respond to — an outline, so it reads as "not applicable"
    // rather than "not done".
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
  if (allHandled) {
    return <CheckIcon size={13} className="text-[var(--handled)]" />;
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

/**
 * One bar per comment rather than a continuous fill. At these counts — three,
 * seven — "four left" is a thing you can see without reading the number.
 */
function Meter({ done, total }: { done: number; total: number }) {
  // Above a dozen the bars get too thin to read, so it becomes a plain bar.
  if (total > 12) {
    return (
      <span className="block h-1.5 w-[92px] overflow-hidden rounded-sm bg-[var(--border)]">
        <span
          className="block h-full rounded-sm bg-[var(--handled)]"
          style={{ width: `${Math.round((done / total) * 100)}%` }}
        />
      </span>
    );
  }

  return (
    <span className="flex gap-[2px]">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className="block h-1.5 w-3.5 rounded-sm"
          style={{
            background: i < done ? "var(--handled)" : "var(--border)",
          }}
        />
      ))}
    </span>
  );
}
