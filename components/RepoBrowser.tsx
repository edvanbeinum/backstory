"use client";

import { useCallback, useEffect, useState } from "react";

import type { BrowseResult } from "@/lib/browse";
import type { ApiError } from "@/lib/types";
import {
  ChevronRightIcon,
  FolderIcon,
  GitCommitIcon,
  RepoIcon,
  XIcon,
} from "./icons";
import { Spinner } from "./ui";

/**
 * Find a checkout without typing its path.
 *
 * Sibling worktrees lead, because in a stacked-branch workflow they're what
 * you're switching between — and `git worktree list` knows them exactly,
 * including which branch each holds, so there's nothing to hunt for. The
 * directory navigator underneath covers everything else.
 */
export function RepoBrowser({
  currentRepo,
  onPick,
  onClose,
}: {
  currentRepo: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start where the open repo lives, so the first thing you see is its
  // neighbourhood rather than your home directory.
  const [dir, setDir] = useState<string | null>(null);

  const load = useCallback(
    async (target: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (target) params.set("path", target);
        if (currentRepo) params.set("repo", currentRepo);

        const response = await fetch(`/api/browse?${params}`, {
          cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok) throw new Error((body as ApiError).error);
        setData(body as BrowseResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [currentRepo],
  );

  useEffect(() => {
    // Opening at the repo's parent puts its siblings on screen immediately.
    const start = currentRepo
      ? currentRepo.slice(0, currentRepo.lastIndexOf("/")) || null
      : null;
    setDir(start);
    void load(start);
  }, [currentRepo, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (target: string) => {
    setDir(target);
    void load(target);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Choose a repository"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--canvas)] shadow-[var(--overlay-shadow)]"
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--canvas-subtle)] px-3 py-2">
          <FolderIcon size={14} className="text-[var(--fg-muted)]" />
          <span className="mono min-w-0 flex-1 truncate text-[12px]">
            {data?.path ?? "…"}
          </span>
          {loading && <Spinner />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            <XIcon size={14} />
          </button>
        </header>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          {error && (
            <p className="px-3 py-3 text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {data && data.worktrees.length > 1 && (
            <section className="border-b border-[var(--border-muted)]">
              <h3 className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
                Worktrees of this repository
              </h3>
              <ul>
                {data.worktrees.map((worktree) => (
                  <li key={worktree.path}>
                    <button
                      type="button"
                      disabled={worktree.missing}
                      onClick={() => onPick(worktree.path)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--canvas-subtle)] disabled:opacity-50 ${
                        worktree.isCurrent ? "bg-[var(--accent-subtle)]" : ""
                      }`}
                    >
                      <RepoIcon
                        size={13}
                        className="shrink-0 text-[var(--fg-muted)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px]">
                        {worktree.name}
                      </span>
                      {worktree.branch && (
                        <span className="mono flex shrink-0 items-center gap-1 text-[11px] text-[var(--fg-muted)]">
                          <GitCommitIcon size={11} />
                          {worktree.branch}
                        </span>
                      )}
                      {worktree.isCurrent && (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--accent)]">
                          open
                        </span>
                      )}
                      {worktree.missing && (
                        <span className="shrink-0 text-[10px] text-[var(--attention)]">
                          missing
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ul>
            {data?.parent && (
              <li>
                <button
                  type="button"
                  onClick={() => go(data.parent!)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--canvas-subtle)]"
                >
                  <FolderIcon
                    size={13}
                    className="shrink-0 text-[var(--fg-subtle)]"
                  />
                  <span className="mono text-[12px] text-[var(--fg-muted)]">
                    ..
                  </span>
                </button>
              </li>
            )}

            {data?.entries.map((entry) => (
              <li key={entry.path} className="flex items-stretch">
                {/* Two targets: open it, or step into it. A repo folder can
                    hold nested repos, so stepping in must stay available. */}
                <button
                  type="button"
                  onClick={() =>
                    entry.isRepo ? onPick(entry.path) : go(entry.path)
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--canvas-subtle)]"
                >
                  {entry.isRepo ? (
                    <RepoIcon
                      size={13}
                      className="shrink-0 text-[var(--accent)]"
                    />
                  ) : (
                    <FolderIcon
                      size={13}
                      className="shrink-0 text-[var(--fg-subtle)]"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {entry.name}
                  </span>
                  {entry.isRepo && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--fg-subtle)]">
                      open
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => go(entry.path)}
                  aria-label={`Open ${entry.name}`}
                  title="Look inside"
                  className="shrink-0 px-2 text-[var(--fg-subtle)] hover:bg-[var(--canvas-subtle)] hover:text-[var(--fg)]"
                >
                  <ChevronRightIcon size={12} />
                </button>
              </li>
            ))}

            {data && data.entries.length === 0 && !loading && (
              <li className="px-3 py-4 text-[12px] text-[var(--fg-muted)]">
                Nothing to show in this folder.
              </li>
            )}
          </ul>
        </div>

        <footer className="border-t border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1.5 text-[11px] text-[var(--fg-muted)]">
          Folders with a repo icon can be opened directly · Esc to close
        </footer>
      </div>
    </div>
  );
}
