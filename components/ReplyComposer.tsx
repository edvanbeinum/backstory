"use client";

import { useEffect, useMemo, useState } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { CommitSummary, PullRequestInfo, RepoInfo } from "@/lib/types";
import { LinkExternalIcon } from "./icons";
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

function templateText(
  template: Template,
  commit: CommitSummary | null,
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
 * Drafts a reply against the *currently selected* commit and hands it over via
 * the clipboard. differ never posts to GitHub — you paste this into the thread
 * yourself, which keeps the last word on wording (and on whether to reply at
 * all) with you.
 */
export function ReplyComposer({
  repo,
  pr,
  commit,
  threadUrl,
}: {
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  threadUrl: string;
}) {
  const [template, setTemplate] = useState<Template>("url");
  const [custom, setCustom] = useState("");

  const url = useMemo(
    () => (commit ? buildPrCommitUrl(repo, pr, commit.sha) : null),
    [repo, pr, commit],
  );

  const generated = templateText(template, commit, url);
  const text = template === "custom" ? custom : generated;

  // Seed the custom box from whatever was last generated, so switching to
  // "write my own" is an edit rather than a blank page.
  useEffect(() => {
    if (template === "custom" && !custom) {
      setCustom(templateText("url", commit, url));
    }
  }, [template, custom, commit, url]);

  if (!commit) {
    return (
      <p className="text-[12px] text-[var(--fg-muted)]">
        Select a commit to draft a reply that links to it.
      </p>
    );
  }

  const isWorking = commit.sha === WORKING_REV;
  const isBranch = commit.sha === BRANCH_REV;

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
      ) : (
        <>
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
