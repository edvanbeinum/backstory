"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  CommitSummary,
  PullRequestInfo,
  RepoInfo,
  ReviewComment,
  ReviewThread,
} from "@/lib/types";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "./icons";
import { ReplyComposer } from "./ReplyComposer";
import { Badge, RelativeTime } from "./ui";

function Avatar({ url, login }: { url: string | null; login: string }) {
  if (!url) {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--canvas-subtle)] text-[10px] font-semibold text-[var(--fg-muted)]">
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={url}
      alt=""
      width={20}
      height={20}
      className="h-5 w-5 shrink-0 rounded-full"
    />
  );
}

function Comment({ comment }: { comment: ReviewComment }) {
  return (
    <div className="border-t border-[var(--border-muted)] px-3 py-2.5 first:border-t-0">
      <div className="mb-1.5 flex items-center gap-2 text-[12px]">
        <Avatar url={comment.avatarUrl} login={comment.author} />
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-[var(--fg)] hover:text-[var(--accent)] hover:underline"
        >
          {comment.author}
        </a>
        <span className="text-[var(--fg-muted)]">
          <RelativeTime iso={comment.createdAt} />
        </span>
      </div>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {comment.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** The comment's original diff context, the way GitHub shows it above a thread. */
function DiffHunkPreview({ hunk }: { hunk: string }) {
  const lines = hunk.split("\n").slice(-8);

  return (
    <div className="overflow-x-auto border-b border-[var(--border-muted)] bg-[var(--canvas-inset)]">
      <table className="diff-table">
        <tbody>
          {lines.map((line, index) => {
            const type = line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "context";

            if (type === "hunk") {
              return (
                <tr key={index} className="line-hunk">
                  <td colSpan={2}>{line}</td>
                </tr>
              );
            }

            return (
              <tr key={index} className={type === "context" ? "" : `line-${type}`}>
                <td className="diff-marker">
                  {type === "add" ? "+" : type === "del" ? "-" : " "}
                </td>
                <td className="diff-code">{line.slice(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  repo,
  pr,
  commit,
  showContext = false,
  defaultCollapsed,
  highlighted = false,
}: {
  thread: ReviewThread;
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  /** Show the comment's captured diff hunk — useful when not anchored inline */
  showContext?: boolean;
  defaultCollapsed?: boolean;
  highlighted?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(
    defaultCollapsed ?? thread.isResolved,
  );

  const first = thread.comments[0];
  const threadUrl = first?.url ?? pr?.url ?? "";
  const replies = thread.comments.length - 1;

  return (
    <div
      id={`thread-${thread.id}`}
      className={`overflow-hidden rounded-md border bg-[var(--canvas)] ${
        highlighted
          ? "border-[var(--attention)]"
          : "border-[var(--border)]"
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2 bg-[var(--canvas-subtle)] px-3 py-2 text-left"
      >
        {collapsed ? (
          <ChevronRightIcon size={14} className="text-[var(--fg-muted)]" />
        ) : (
          <ChevronDownIcon size={14} className="text-[var(--fg-muted)]" />
        )}

        <span className="mono min-w-0 flex-1 truncate text-[12px] text-[var(--fg-muted)]">
          {thread.path ?? "General comment"}
          {thread.line != null && (
            <span className="text-[var(--fg-subtle)]">:{thread.line}</span>
          )}
        </span>

        {replies > 0 && (
          <span className="text-[11px] text-[var(--fg-muted)]">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        )}

        {thread.isOutdated && <Badge>outdated</Badge>}

        {thread.isResolved ? (
          <Badge tone="merged">
            <CheckIcon size={11} /> resolved
          </Badge>
        ) : (
          <Badge tone="attention">open</Badge>
        )}
      </button>

      {!collapsed && (
        <>
          {showContext && first?.diffHunk && (
            <DiffHunkPreview hunk={first.diffHunk} />
          )}

          {thread.comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}

          <div className="border-t border-[var(--border-muted)] bg-[var(--canvas-subtle)] p-2">
            <ReplyComposer
              repo={repo}
              pr={pr}
              commit={commit}
              threadUrl={threadUrl}
              suggestedSha={thread.addressedBySha}
            />
          </div>
        </>
      )}
    </div>
  );
}
