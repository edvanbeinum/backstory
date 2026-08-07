"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { CommitSummary, PullRequestInfo, RepoInfo } from "@/lib/types";
import {
  CheckIcon,
  ChevronDownIcon,
  LinkExternalIcon,
  LinkIcon,
  PinIcon,
} from "./icons";
import { CopyButton } from "./ui";

type Template = "url" | "sha" | "thumbsUp" | "noChange" | "custom";

/** Reply wording for a comment answered by a commit. */
const COMMIT_TEMPLATES: Array<{ id: Template; label: string }> = [
  { id: "url", label: "Addressed in <link>" },
  { id: "sha", label: "Addressed in <sha>" },
  { id: "thumbsUp", label: "👍 Addressed in <sha>" },
  { id: "custom", label: "Write my own" },
];

/** Reply wording for one that only wanted an acknowledgement. */
const ACK_TEMPLATES: Array<{ id: Template; label: string }> = [
  { id: "thumbsUp", label: "👍" },
  { id: "noChange", label: "Noted, no change" },
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
  switch (template) {
    case "noChange":
      return "Noted — no change needed here, thanks.";
    case "thumbsUp":
      return commit ? `👍 Addressed in ${commit.shortSha}` : "👍";
    case "url":
      return commit ? `Addressed in ${url ?? commit.sha}` : "";
    case "sha":
      return commit ? `Addressed in ${commit.shortSha}` : "";
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
 * Which commit gets linked is never guessed: it's the one you linked to this
 * comment, or the one selected in the change column if you haven't linked yet.
 * A comment marked as needing no change gets acknowledgement wording instead.
 */
export function ReplyComposer({
  repo,
  pr,
  commit,
  threadUrl,
  linkedSha,
  linkedShaMissing = false,
  linkedShaHealed = false,
  acknowledged = false,
  onPin,
  pinCandidates = [],
  draft,
  onDraftChange,
}: {
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  threadUrl: string;
  /** The commit you linked to this comment */
  linkedSha?: string | null;
  /** The linked sha is gone and couldn't be re-matched */
  linkedShaMissing?: boolean;
  /** The link was re-matched to a rewritten commit by patch-id */
  linkedShaHealed?: boolean;
  /** Handled without a code change — reply wording changes accordingly */
  acknowledged?: boolean;
  /** Link the thread to a sha, or clear it with null */
  onPin?: (sha: string | null) => void;
  /**
   * Branch commits available to link. The right commit is often not the one
   * on screen: a fix can land in a different file from the one commented on.
   */
  pinCandidates?: CommitSummary[];
  /** A previously saved draft for this thread, if any */
  draft?: string | null;
  /** Persist the draft; null clears it. Absent = drafts not saved. */
  onDraftChange?: (text: string | null) => void;
}) {
  // A saved draft is text you wrote and haven't sent — resume straight into
  // it rather than showing a template and burying it.
  const templates = acknowledged ? ACK_TEMPLATES : COMMIT_TEMPLATES;
  const [template, setTemplate] = useState<Template>(
    draft ? "custom" : acknowledged ? "thumbsUp" : "url",
  );
  const [custom, setCustom] = useState(draft ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedIsReal =
    commit !== null &&
    commit.sha !== WORKING_REV &&
    commit.sha !== BRANCH_REV;

  // A live link is the answer. One whose commit was rebased away is
  // surfaced rather than obeyed.
  const pinned: LinkTarget | null =
    linkedSha && !linkedShaMissing
      ? { sha: linkedSha, shortSha: linkedSha.slice(0, 7) }
      : null;

  const target: LinkTarget | null =
    pinned ?? (selectedIsReal ? commit : null);

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

  // Persist the draft, debounced — the point is that it survives a reload,
  // a collapse, or switching commits, not that every keystroke hits disk.
  // The saved value is compared against so a session refresh echoing the
  // draft back can't trigger a pointless write.
  const savedRef = useRef(draft ?? "");
  useEffect(() => {
    savedRef.current = draft ?? "";
  }, [draft]);

  useEffect(() => {
    if (!onDraftChange || template !== "custom") return;
    if (custom === savedRef.current) return;

    const timer = setTimeout(() => {
      savedRef.current = custom;
      onDraftChange(custom.trim() === "" ? null : custom);
    }, 600);
    return () => clearTimeout(timer);
  }, [custom, template, onDraftChange]);

  // An acknowledged comment needs no commit at all, so it skips every
  // "pick a commit first" branch below.
  const isWorking = !acknowledged && target === null && commit?.sha === WORKING_REV;
  const isBranch = !acknowledged && target === null && commit?.sha === BRANCH_REV;
  const needsCommit = !acknowledged && target === null;

  // Offer to link whatever is on screen, once it's a real commit
  const canPin = onPin !== undefined && target !== null && pinned === null;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-muted)] px-2 py-1.5">
        {templates.map((option) => (
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
      ) : needsCommit ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--fg-muted)]">
          Link this comment to a commit — or mark it as needing no change —
          and the reply drafts itself.
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-2 border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">
            {linkedShaMissing && (
              <span className="text-[var(--attention)]">
                <LinkIcon size={11} /> Linked to{" "}
                <span className="mono">{linkedSha?.slice(0, 7)}</span>, which
                is no longer on this branch and doesn&apos;t match any commit
                here — squashed, amended, or rebased through a conflict.
              </span>
            )}

            {acknowledged ? (
              <span className="text-[var(--fg)]">
                <CheckIcon size={11} className="text-[var(--done)]" />{" "}
                Acknowledged — no code change needed.
              </span>
            ) : pinned ? (
              <span className="text-[var(--fg)]">
                <LinkIcon size={11} className="text-[var(--done)]" /> Linked to{" "}
                <span className="mono">{pinned.shortSha}</span>
                {linkedShaHealed && (
                  <span className="text-[var(--fg-muted)]">
                    {" "}
                    · re-matched after a rebase
                  </span>
                )}
              </span>
            ) : (
              <>
                Would link the selected commit{" "}
                <span className="mono">{target?.shortSha}</span>.
              </>
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
                            candidate.sha === linkedSha
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

            {onPin && linkedSha && (
              <button
                type="button"
                onClick={() => onPin(null)}
                className="text-[var(--accent)] hover:underline"
              >
                {linkedShaMissing ? "Clear pin" : "Unpin"}
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

            {/* Say plainly that the text is safe — an unsaved-looking box is
                the reason drafts felt risky in the first place. */}
            {draft && template === "custom" && (
              <span className="text-[11px] text-[var(--fg-muted)]">
                Draft saved
              </span>
            )}
            {draft && onDraftChange && (
              <button
                type="button"
                onClick={() => {
                  setCustom("");
                  savedRef.current = "";
                  onDraftChange(null);
                  setTemplate("url");
                }}
                className="text-[11px] text-[var(--accent)] hover:underline"
              >
                Discard draft
              </button>
            )}

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
