"use client";

import { useEffect, useState } from "react";

import type { PullRequestInfo, RepoInfo, ReviewThread } from "@/lib/types";
import { buildPrCommitUrl } from "./ReplyComposer";
import { CheckIcon } from "./icons";
import { CopyButton } from "./ui";

/**
 * Every comment on the PR is handled.
 *
 * This is the one place the big effect is spent. A burst on every tick stops
 * being a reward by the third one; a burst that only ever fires here keeps
 * meaning something, and it happens to fire at the exact moment differ has
 * done its whole job.
 *
 * The substance is still the substance: the count, every reply on the
 * clipboard in one go, and the way back to the rest of the work.
 */
export function CompletionCard({
  threads,
  branch,
  repo,
  pr,
  onBack,
}: {
  threads: ReviewThread[];
  branch: string | null;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  onBack?: () => void;
}) {
  const replies = threads.filter((t) => t.response.reply);

  return (
    <div className="relative overflow-hidden rounded-md border border-[var(--handled)] bg-[var(--canvas)] p-4 text-center">
      <Burst />
      <p className="flex items-center justify-center gap-2 text-[15px] font-semibold">
        <CheckIcon size={16} className="text-[var(--handled)]" />
        {threads.length} of {threads.length} handled
      </p>
      <p className="mx-auto mt-1 max-w-[34ch] text-[12px] text-[var(--fg-muted)]">
        Nothing left{branch ? ` on ${branch}` : ""}. Paste the replies when
        you&apos;re ready — differ still hasn&apos;t touched GitHub.
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {replies.length > 0 && (
          <CopyButton
            value={() => allReplies(replies, repo, pr)}
            label={`Copy all ${replies.length} ${
              replies.length === 1 ? "reply" : "replies"
            }`}
          />
        )}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-[#1f883d] bg-[#1f883d] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#1a7f37]"
          >
            ‹ Inbox
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Each reply headed by where it goes, because they're pasted one at a time
 * into different threads and an unlabelled wall of text can't be.
 */
function allReplies(
  threads: ReviewThread[],
  repo: RepoInfo,
  pr: PullRequestInfo | null,
): string {
  return threads
    .map((thread) => {
      const where = thread.path
        ? `${thread.path}${thread.line != null ? `:${thread.line}` : ""}`
        : "Review summary";
      const url = thread.comments[0]?.url;
      const sha = thread.response.commit?.sha;
      const link = sha ? buildPrCommitUrl(repo, pr, sha) : null;
      return [
        `## ${where}`,
        url ? `<${url}>` : null,
        "",
        thread.response.reply,
        link ? `\n${link}` : null,
      ]
        .filter((line) => line !== null)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

/** Twelve particles, once, then gone from the DOM entirely. */
function Burst() {
  const [live, setLive] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setLive(false), 1000);
    return () => clearTimeout(timer);
  }, []);

  if (!live) return null;

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-6 block h-0 w-0"
    >
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        return (
          <span
            key={i}
            className="burst-particle absolute block h-1.5 w-1.5 rounded-full bg-[var(--handled)]"
            style={
              {
                "--dx": `${Math.cos(angle) * 90}px`,
                "--dy": `${Math.sin(angle) * 90}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
