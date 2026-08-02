"use client";

import { useState } from "react";

import type { DiffFile, ReviewThread } from "@/lib/types";
import { ChevronDownIcon, ChevronRightIcon, CommentIcon } from "./icons";

const STATUS_LETTER: Record<string, { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-[var(--success)]" },
  deleted: { letter: "D", tone: "text-[var(--danger)]" },
  modified: { letter: "M", tone: "text-[var(--attention)]" },
  renamed: { letter: "R", tone: "text-[var(--done)]" },
  copied: { letter: "C", tone: "text-[var(--done)]" },
};

/**
 * A collapsible index of the files in the current diff — collapsed by
 * default, since it's a navigator rather than content. Clicking a row jumps
 * to that file's section in the diff and flashes it.
 */
export function FileNav({
  files,
  threads,
}: {
  files: DiffFile[];
  threads: ReviewThread[];
}) {
  const [open, setOpen] = useState(false);

  if (files.length < 2) return null;

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  const jump = (path: string) => {
    const element = document.getElementById(
      `file-${encodeURIComponent(path)}`,
    );
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.add("flash");
    setTimeout(() => element.classList.remove("flash"), 1500);
  };

  const openThreadCount = (file: DiffFile) =>
    threads.filter(
      (t) =>
        !t.isResolved &&
        t.path !== null &&
        (t.path === file.newPath || t.path === file.oldPath),
    ).length;

  return (
    <section className="overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--canvas-subtle)]"
      >
        {open ? (
          <ChevronDownIcon size={14} className="text-[var(--fg-muted)]" />
        ) : (
          <ChevronRightIcon size={14} className="text-[var(--fg-muted)]" />
        )}
        <span className="flex-1 text-[13px] font-semibold">
          {files.length} files changed
        </span>
        <span className="mono text-[11px]">
          <span className="text-[var(--success)]">+{additions}</span>{" "}
          <span className="text-[var(--danger)]">−{deletions}</span>
        </span>
      </button>

      {open && (
        <ul className="border-t border-[var(--border-muted)] py-1">
          {files.map((file) => {
            const status = STATUS_LETTER[file.status] ?? {
              letter: "?",
              tone: "text-[var(--fg-muted)]",
            };
            const comments = openThreadCount(file);
            const slash = file.path.lastIndexOf("/");
            const dir = slash === -1 ? "" : file.path.slice(0, slash + 1);
            const name = slash === -1 ? file.path : file.path.slice(slash + 1);

            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => jump(file.path)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--canvas-subtle)]"
                >
                  <span
                    className={`mono w-3 shrink-0 text-center text-[11px] font-semibold ${status.tone}`}
                    title={file.status}
                  >
                    {status.letter}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[12px]">
                    <span className="text-[var(--fg-muted)]">{dir}</span>
                    <span className="text-[var(--fg)]">{name}</span>
                  </span>
                  {comments > 0 && (
                    <span
                      className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--attention)]"
                      title={`${comments} open review ${comments === 1 ? "thread" : "threads"}`}
                    >
                      <CommentIcon size={11} />
                      {comments}
                    </span>
                  )}
                  <span className="mono shrink-0 text-[11px]">
                    <span className="text-[var(--success)]">
                      +{file.additions}
                    </span>{" "}
                    <span className="text-[var(--danger)]">
                      −{file.deletions}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
