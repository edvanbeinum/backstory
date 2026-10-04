"use client";

import { useState } from "react";

import type { CommitSummary } from "@/lib/types";
import { ChevronDownIcon } from "./icons";

/**
 * Choose a commit — by scrolling, by filtering, or by pasting its sha.
 *
 * One component for both places that offer commits (linking one to a comment,
 * and picking what the diff column shows) because they were drifting: one
 * grew a filter box and the other didn't, so "search for a commit" worked or
 * didn't depending on which dropdown you happened to open.
 *
 * Pasting matters more than it looks. differ offers the branch's recent
 * commits, and the one you want is often outside that window or on another
 * branch entirely — searching a list you know it isn't in is the wrong shape
 * of work. So an unrecognised sha is offered rather than refused, and
 * whatever consumes it decides whether it's real.
 */
export function CommitPicker({
  label,
  candidates,
  selected,
  onPick,
  align = "right",
  variant = "link",
}: {
  label: string;
  candidates: CommitSummary[];
  /** Full sha of the current choice, highlighted in the list. */
  selected: string | null;
  onPick: (sha: string) => void;
  align?: "left" | "right";
  /**
   * `link` is the inline text form used in dense rows; `button` gives it the
   * weight of a real control, for places where choosing a commit is the
   * point rather than an aside.
   */
  variant?: "link" | "button";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = trimmed
    ? candidates.filter(
        (c) =>
          c.sha.startsWith(needle) || c.subject.toLowerCase().includes(needle),
      )
    : candidates;

  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(trimmed);
  const offerRaw =
    looksLikeSha && !matches.some((c) => c.sha.startsWith(needle));

  const choose = (sha: string) => {
    setOpen(false);
    setQuery("");
    onPick(sha);
  };

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          variant === "button"
            ? "inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1.5 text-[12px] font-medium hover:border-[var(--fg-muted)]"
            : "inline-flex items-center gap-0.5 font-medium text-[var(--accent)] hover:underline"
        }
      >
        {label}
        <ChevronDownIcon size={variant === "button" ? 11 : 10} />
      </button>

      {open && (
        <div
          className={`absolute top-full z-40 mt-1 w-[24rem] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--canvas)] text-left shadow-[var(--overlay-shadow)] ${
            align === "left" ? "left-0" : "right-0"
          }`}
          // Closing on blur belongs to the whole popover, not the trigger:
          // hung on the button, focusing the input would dismiss the list the
          // input lives in.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setTimeout(() => setOpen(false), 120);
            }
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // The global j/k/x handler ignores inputs, but stop it here too
              // so typing a subject line can never move the selection.
              event.stopPropagation();
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter") {
                event.preventDefault();
                if (offerRaw) choose(trimmed);
                else if (matches[0]) choose(matches[0].sha);
              }
            }}
            placeholder="Paste a sha, or filter by message"
            spellCheck={false}
            className="mono w-full border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-2.5 py-1.5 text-[11px] outline-none"
          />

          <ul className="max-h-72 overflow-y-auto py-1">
            {offerRaw && (
              <li>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(trimmed);
                  }}
                  className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left hover:bg-[var(--canvas-subtle)]"
                >
                  <span className="mono shrink-0 text-[11px] font-semibold text-[var(--accent)]">
                    {trimmed}
                  </span>
                  <span className="text-[11px] text-[var(--fg-muted)]">
                    use this sha
                  </span>
                </button>
              </li>
            )}

            {matches.map((candidate) => (
              <li key={candidate.sha}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    // mousedown: blur would close the list before a click
                    event.preventDefault();
                    choose(candidate.sha);
                  }}
                  className={`flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-[var(--canvas-subtle)] ${
                    candidate.sha === selected
                      ? "bg-[var(--accent-subtle)]"
                      : ""
                  }`}
                >
                  <span className="mono shrink-0 text-[11px] text-[var(--fg-muted)]">
                    {candidate.shortSha}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">
                    {candidate.subject}
                  </span>
                </button>
              </li>
            ))}

            {matches.length === 0 && !offerRaw && (
              <li className="px-2.5 py-2 text-[11px] text-[var(--fg-muted)]">
                {trimmed
                  ? "Nothing matches. A full or short sha can be used even if it isn't listed."
                  : "differ found no commits on this branch to offer."}
              </li>
            )}
          </ul>
        </div>
      )}
    </span>
  );
}
