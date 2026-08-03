"use client";

import { useEffect, useMemo, useState } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { CommitSummary, PullRequestInfo, RepoInfo } from "@/lib/types";
import { ChevronDownIcon, LinkExternalIcon, PinIcon } from "./icons";
import { CopyButton } from "./ui";

type Template = "url" | "sha" | "ack" | "custom";

const TEMPLATES: Array<{ id: Template; label: string }> = [
  { id: "url", label: "Addressed in <link>" },
  { id: "sha", label: "Addressed in <sha>" },
  { id: "ack", label: "👍 Addressed in <sha>" },
  { id: "custom", label: "Write my own" },
];

export function buildPrCommitUrl(
  repo: RepoInfo,
  pr: PullRequestInfo | null,
  sha: string,
): string | null {
  if (!repo.owner || !repo.name) return null;
  // The in-PR commit view — the link form GitHub renders nicely in replies.
  if (pr) {
    return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}/commits/${sha}`;
  }
  return `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`;
}

/** The composer only needs a sha to link — not a full CommitSummary. */
type LinkTarget = Pick<CommitSummary, "sha" | "shortSha">;

function templateText(
  template: Template,
  commit: LinkTarget | null,
  url: string | null,
): string {
  if (!commit) return "";
  switch (template) {
    case "url":
      return `Addressed in ${url ?? commit.sha}`;
    case "sha":
      return `Addressed in ${commit.shortSha}`;
    case "ack":
      return `👍 Addressed in ${commit.shortSha}`;
    default:
      return "";
  }
}

/**
 * Drafts an "Addressed in <commit>" reply and hands it over via the
 * clipboard. differ never posts to GitHub — you paste this into the thread
 * yourself, which keeps the last word on wording (and on whether to reply at
 * all) with you.
 *
 * Which commit gets linked: by default the newest branch commit that touched
 * the thread's file (`suggestedSha`, computed server-side) — the commit that
 * most plausibly addressed the comment — regardless of which commit is
 * selected in the rail. The selected commit is one click away. Without a
 * suggestion, the selected commit is used as before.
 */
export function ReplyComposer({
  repo,
  pr,
  commit,
  threadUrl,
  suggestedSha,
  pinnedSha,
  pinnedShaMissing = false,
  onPin,
  pinCandidates = [],
}: {
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  threadUrl: string;
  /** Newest branch commit touching the thread's file, if known */
  suggestedSha?: string | null;
  /** A commit the user pinned to this thread — beats the suggestion */
  pinnedSha?: string | null;
  /** The pinned sha is gone (rebased away) */
  pinnedShaMissing?: boolean;
  /** Pin the thread to a sha, or unpin with null. Absent = pinning off. */
  onPin?: (sha: string | null) => void;
  /**
   * Branch commits available to pin. Needed because the right commit often
   * isn't the guess *or* the selection: a fix can land in a different file
   * from the one commented on, which no file-level heuristic can reach.
   */
  pinCandidates?: CommitSummary[];
}) {
  const [template, setTemplate] = useState<Template>("url");
  const [custom, setCustom] = useState("");
  const [preferSelected, setPreferSelected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedIsReal =
    commit !== null &&
    commit.sha !== WORKING_REV &&
    commit.sha !== BRANCH_REV;

  const suggested: LinkTarget | null = suggestedSha
    ? { sha: suggestedSha, shortSha: suggestedSha.slice(0, 7) }
    : null;

  // A live pin is the answer, full stop — that's what pinning is for. A pin
  // whose commit was rebased away is surfaced rather than obeyed.
  const pinned: LinkTarget | null =
    pinnedSha && !pinnedShaMissing
      ? { sha: pinnedSha, shortSha: pinnedSha.slice(0, 7) }
      : null;

  const target: LinkTarget | null =
    pinned ??
    (preferSelected && selectedIsReal
      ? commit
      : (suggested ?? (selectedIsReal ? commit : null)));

  const url = useMemo(
    () => (target ? buildPrCommitUrl(repo, pr, target.sha) : null),
    [repo, pr, target],
  );

  const generated = templateText(template, target, url);
  const text = template === "custom" ? custom : generated;

  // Seed the custom box from whatever was last generated, so switching to
  // "write my own" is an edit rather than a blank page.
  useEffect(() => {
    if (template === "custom" && !custom) {
      setCustom(templateText("url", target, url));
    }
  }, [template, custom, target, url]);

  if (!commit && !suggested) {
    return (
      <p className="text-[12px] text-[var(--fg-muted)]">
        Select a commit to draft a reply that links to it.
      </p>
    );
  }

  const isWorking = target === null && commit?.sha === WORKING_REV;
  const isBranch = target === null && commit?.sha === BRANCH_REV;

  const linkingSuggested =
    pinned === null &&
    target !== null &&
    suggested !== null &&
    target.sha === suggested.sha;
  const showSwap =
    pinned === null &&
    suggested !== null &&
    selectedIsReal &&
    commit.sha !== suggested.sha;
  // Offer to pin whatever is currently being linked, once it's a real commit
  const canPin = onPin !== undefined && target !== null && pinned === null;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-muted)] px-2 py-1.5">
        {TEMPLATES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setTemplate(option.id)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              template === option.id
                ? "bg-[var(--accent-subtle)] text-[var(--accent)]"
                : "text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isWorking ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--fg-muted)]">
          Uncommitted work has no SHA yet. Commit it, then come back and this
          will link to the new commit.
        </p>
      ) : isBranch ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--fg-muted)]">
          This is the combined branch diff — select a single commit in the
          rail to draft a reply that links to it.
        </p>
      ) : target === null ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--fg-muted)]">
          Select a commit to draft a reply that links to it.
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-2 border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">
            {pinnedShaMissing && (
              <span className="text-[var(--attention)]">
                <PinIcon size={11} /> Pinned to{" "}
                <span className="mono">{pinnedSha?.slice(0, 7)}</span>, which
                is no longer on this branch — probably rebased away.
              </span>
            )}

            {pinned ? (
              <span className="text-[var(--fg)]">
                <PinIcon size={11} className="text-[var(--done)]" /> Pinned to{" "}
                <span className="mono">{pinned.shortSha}</span>
              </span>
            ) : linkingSuggested ? (
              <>
                Links <span className="mono">{target.shortSha}</span> — the
                last commit that touched this file.
              </>
            ) : (
              <>
                Links the selected commit{" "}
                <span className="mono">{target.shortSha}</span>.
              </>
            )}

            {showSwap && (
              <button
                type="button"
                onClick={() => setPreferSelected((value) => !value)}
                className="text-[var(--accent)] hover:underline"
              >
                {linkingSuggested
                  ? `Link selected ${commit.shortSha} instead`
                  : `Link ${suggested.shortSha} (last touched this file)`}
              </button>
            )}

            <span className="flex-1" />

            {canPin && (
              <button
                type="button"
                onClick={() => onPin(target.sha)}
                title="Always link this commit for this thread"
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
              >
                <PinIcon size={11} /> Pin {target.shortSha}
              </button>
            )}

            {onPin && pinCandidates.length > 0 && (
              <span className="relative">
                <button
                  type="button"
                  onClick={() => setPickerOpen((value) => !value)}
                  onBlur={() => setTimeout(() => setPickerOpen(false), 120)}
                  className="inline-flex items-center gap-0.5 text-[var(--accent)] hover:underline"
                >
                  {pinned ? "Repin to…" : "Pin to…"}
                  <ChevronDownIcon size={10} />
                </button>

                {pickerOpen && (
                  <ul className="absolute bottom-full right-0 z-40 mb-1 max-h-72 w-[22rem] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--canvas)] py-1 shadow-[var(--overlay-shadow)]">
                    {pinCandidates.map((candidate) => (
                      <li key={candidate.sha}>
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            // mousedown: the button's onBlur would otherwise
                            // close the list before this click registers
                            event.preventDefault();
                            setPickerOpen(false);
                            onPin(candidate.sha);
                          }}
                          className={`flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-[var(--canvas-subtle)] ${
                            candidate.sha === pinnedSha
                              ? "bg-[var(--accent-subtle)]"
                              : ""
                          }`}
                        >
                          <span className="mono shrink-0 text-[11px] text-[var(--fg-muted)]">
                            {candidate.shortSha}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg)]">
                            {candidate.subject}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </span>
            )}

            {onPin && pinnedSha && (
              <button
                type="button"
                onClick={() => onPin(null)}
                className="text-[var(--accent)] hover:underline"
              >
                {pinnedShaMissing ? "Clear pin" : "Unpin"}
              </button>
            )}
          </p>
          <textarea
            value={text}
            readOnly={template !== "custom"}
            onChange={(event) => setCustom(event.target.value)}
            rows={template === "custom" ? 3 : 2}
            className={`mono w-full resize-y bg-transparent px-3 py-2 text-[12px] leading-5 outline-none ${
              template === "custom" ? "" : "text-[var(--fg-muted)]"
            }`}
          />

          <div className="flex items-center gap-2 border-t border-[var(--border-muted)] px-2 py-1.5">
            <CopyButton value={text} label="Copy reply" />
            <a
              href={threadUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[var(--accent)] hover:underline"
            >
              Open thread <LinkExternalIcon size={12} />
            </a>
            <span className="flex-1" />
            {url && (
              <CopyButton
                value={url}
                label="Copy link"
                variant="invisible"
                copiedLabel="Copied"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Standalone "copy a link to this commit" control for the commit header. */
export function CommitLinkButton({
  repo,
  pr,
  commit,
}: {
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary;
}) {
  const url = buildPrCommitUrl(repo, pr, commit.sha);
  if (!url) return null;

  return (
    <div className="flex items-center gap-1.5">
      <CopyButton value={url} label="Copy commit link" variant="invisible" />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center text-[var(--fg-muted)] hover:text-[var(--accent)]"
        title="Open on GitHub"
      >
        <LinkExternalIcon size={14} />
      </a>
    </div>
  );
}
