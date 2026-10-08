"use client";

import { useEffect, useRef, useState } from "react";

import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  GitCommitIcon,
  LinkExternalIcon,
  PullRequestIcon,
  SyncIcon,
  XIcon,
} from "./icons";
import { RepoBrowser } from "./RepoBrowser";
import { Badge, Button, CopyButton, Spinner } from "./ui";
import type { RecentRepo } from "@/lib/recents";
import type { SessionResponse } from "@/lib/types";

export function RepoBar({
  repoPath,
  onRepoPathChange,
  session,
  loading,
  onRefresh,
  live = false,
  recents = [],
  onRemoveRecent,
  onBackToInbox,
}: {
  repoPath: string;
  onRepoPathChange: (value: string) => void;
  session: SessionResponse | null;
  loading: boolean;
  onRefresh: () => void;
  /** The watch stream is connected — changes appear without reloading */
  live?: boolean;
  /** Previously-opened repos, newest first, for the dropdown */
  recents?: RecentRepo[];
  onRemoveRecent?: (path: string) => void;
  /** Leave the workspace for the home screen. */
  onBackToInbox?: () => void;
}) {
  const [draft, setDraft] = useState(repoPath);
  const [listOpen, setListOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [shownRepoPath, setShownRepoPath] = useState(repoPath);
  if (shownRepoPath !== repoPath) {
    setShownRepoPath(repoPath);
    setDraft(repoPath);
  }

  // Publish the header's real height so the side column and the sticky file
  // headers can sit directly beneath it. This bar wraps to two or three rows
  // depending on branch name and PR title, so a hard-coded offset would leave
  // content either overlapped or floating.
  useEffect(() => {
    const element = headerRef.current;
    if (!element) return;

    const publish = () => {
      document.documentElement.style.setProperty(
        "--header-height",
        `${element.offsetHeight}px`,
      );
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [session]);

  const pr = session?.github.pr;

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--canvas-subtle)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        {onBackToInbox ? (
          <button
            type="button"
            onClick={onBackToInbox}
            className="flex items-center gap-1.5 text-[13px] text-[var(--accent)] hover:underline"
          >
            <ChevronRightIcon size={13} className="rotate-180" />
            Inbox
          </button>
        ) : (
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <FileDiffIcon className="text-[var(--fg-muted)]" />
            <span>Backstory</span>
          </div>
        )}

        <form
          className="flex min-w-[280px] flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setListOpen(false);
            onRepoPathChange(draft);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => setListOpen(true)}
              onBlur={() => setListOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setListOpen(false);
              }}
              placeholder="/path/to/your/repo"
              spellCheck={false}
              aria-label="Repository path"
              className="mono w-full rounded-md border border-[var(--border)] bg-[var(--canvas)] py-[5px] pl-3 pr-8 text-[12px] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
            />
            {recents.length > 0 && (
              <button
                type="button"
                aria-label="Recent repositories"
                title="Recent repositories"
                // mousedown (not click) so toggling doesn't first blur the
                // input and immediately close what it's about to open
                onMouseDown={(event) => {
                  event.preventDefault();
                  setListOpen((value) => !value);
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
              >
                <ChevronDownIcon size={14} />
              </button>
            )}

            {listOpen && recents.length > 0 && (
              // preventDefault keeps the input focused, so onBlur doesn't
              // close the panel before a row's onClick can run
              <ul
                onMouseDown={(event) => event.preventDefault()}
                className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-[var(--overlay-shadow)]"
              >
                {recents.map((recent) => {
                  const name =
                    recent.path.split("/").filter(Boolean).pop() ?? recent.path;
                  const isCurrent = session?.repo.root === recent.path;
                  return (
                    <li key={recent.path} className="flex items-stretch">
                      <button
                        type="button"
                        title={recent.path}
                        onClick={() => {
                          setListOpen(false);
                          inputRef.current?.blur();
                          onRepoPathChange(recent.path);
                        }}
                        className={`min-w-0 flex-1 px-3 py-1.5 text-left hover:bg-[var(--canvas-subtle)] ${
                          isCurrent ? "bg-[var(--accent-subtle)]" : ""
                        }`}
                      >
                        <span className="block truncate text-[12px] font-medium">
                          {name}
                        </span>
                        <span className="flex items-center gap-1 truncate text-[11px] text-[var(--fg-muted)]">
                          {recent.branch && (
                            <>
                              <GitCommitIcon size={11} />
                              <span className="mono">{recent.branch}</span>
                              <span className="text-[var(--fg-subtle)]">·</span>
                            </>
                          )}
                          <span className="mono truncate text-[var(--fg-subtle)]">
                            {recent.path}
                          </span>
                        </span>
                      </button>
                      {onRemoveRecent && (
                        <button
                          type="button"
                          aria-label={`Forget ${name}`}
                          title="Remove from recents"
                          onClick={() => onRemoveRecent(recent.path)}
                          className="shrink-0 px-2 text-[var(--fg-subtle)] hover:text-[var(--danger)]"
                        >
                          <XIcon size={12} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <Button
            onClick={() => setBrowserOpen(true)}
            size="md"
            title="Find a repository or worktree"
          >
            <FolderIcon size={14} />
            Browse
          </Button>
          <Button type="submit" size="md">
            Open
          </Button>
        </form>

        <div className="flex items-center gap-2">
          {session && (
            <span
              title={
                live
                  ? "Live — changes in the repo appear automatically"
                  : "Not watching — refresh manually"
              }
              className={`text-[9px] ${live ? "text-[var(--success)]" : "text-[var(--fg-subtle)]"}`}
            >
              ●
            </span>
          )}
          {loading && <Spinner />}
          {session && (
            <CopyButton
              // Resolved on click: the URL is kept current with
              // history.replaceState, which doesn't re-render this button.
              value={() => window.location.href}
              label=""
              copiedLabel="Copied"
              title="Copy a link to this view"
              variant="invisible"
              size="md"
              className="!px-2"
            />
          )}
          <Button onClick={onRefresh} variant="invisible" title="Refresh">
            <SyncIcon />
          </Button>
        </div>
      </div>

      {session && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--border-muted)] px-4 py-2 text-[12px] text-[var(--fg-muted)]">
          <span className="mono font-semibold text-[var(--fg)]">
            {session.repo.branch ?? "detached HEAD"}
          </span>

          <span className="text-[var(--fg-subtle)]">
            {session.commits.length}{" "}
            {session.commits.length === 1 ? "commit" : "commits"}{" "}
            {session.base.label}
          </span>

          {session.working.hasChanges && (
            <Badge tone="attention">
              {[
                session.working.staged && `${session.working.staged} staged`,
                session.working.unstaged &&
                  `${session.working.unstaged} unstaged`,
                session.working.untracked &&
                  `${session.working.untracked} untracked`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Badge>
          )}

          <span className="flex-1" />

          {/* The PR title itself is the page heading (PrTitle); the bar just
              keeps a compact pointer for when you've scrolled away from it. */}
          {pr ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[var(--accent)] hover:underline"
            >
              <PullRequestIcon />
              <span className="font-medium">#{pr.number}</span>
              <LinkExternalIcon size={12} />
            </a>
          ) : (
            session.github.unavailable && (
              <span className="flex items-center gap-1.5 text-[var(--fg-subtle)]">
                <AlertIcon size={12} />
                {session.github.unavailable}
              </span>
            )
          )}
        </div>
      )}

      {browserOpen && (
        <RepoBrowser
          currentRepo={session?.repo.root ?? null}
          onPick={(picked) => {
            setBrowserOpen(false);
            onRepoPathChange(picked);
          }}
          onClose={() => setBrowserOpen(false)}
        />
      )}
    </header>
  );
}
