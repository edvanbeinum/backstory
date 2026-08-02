"use client";

import type { PullRequestInfo } from "@/lib/types";
import { LinkExternalIcon, PullRequestIcon } from "./icons";
import { Badge } from "./ui";

function prTone(state: string, isDraft: boolean) {
  if (isDraft) return "draft" as const;
  if (state === "MERGED") return "merged" as const;
  if (state === "CLOSED") return "closed" as const;
  return "open" as const;
}

/**
 * The pull request as a page heading, the way GitHub titles a PR: big title,
 * muted #number, state badge. This is what the whole review is *about*, so it
 * reads as the title of the page rather than a link squeezed into the bar.
 */
export function PrTitle({ pr }: { pr: PullRequestInfo }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 pb-1">
      <h1 className="min-w-0 text-[24px] font-normal leading-8">
        {pr.title}{" "}
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="whitespace-nowrap text-[var(--fg-muted)] hover:text-[var(--accent)]"
          title="Open on GitHub"
        >
          #{pr.number}
          <LinkExternalIcon size={14} className="ml-1 align-baseline" />
        </a>
      </h1>

      <span className="mt-1.5 flex items-center gap-2">
        <Badge tone={prTone(pr.state, pr.isDraft)}>
          <PullRequestIcon size={12} />
          {pr.isDraft ? "Draft" : pr.state.toLowerCase()}
        </Badge>
      </span>
    </div>
  );
}
