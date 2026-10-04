"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { CommitSummary, PullRequestInfo, RepoInfo } from "@/lib/types";
import { LinkExternalIcon } from "./icons";
import { CopyButton } from "./ui";

type Template = "url" | "sha" | "thumbsUp" | "noChange" | "custom";

/**
 * One list, not two.
 *
 * There used to be a separate set for "acknowledged" comments, back when
 * acknowledging was its own kind of handled. It isn't any more — a comment
 * needing no code change is just one you tick without linking a commit — so
 * the only thing that varies is whether there's a commit to name. Those
 * entries disable rather than disappear: a chip row that changes length as
 * you link and unlink is a chip row you can't aim at.
 */
const TEMPLATES: Array<{
  id: Template;
  label: string;
  needsCommit?: boolean;
}> = [
  { id: "url", label: "Addressed in <link>", needsCommit: true },
  { id: "sha", label: "Addressed in <sha>", needsCommit: true },
  { id: "thumbsUp", label: "👍 Addressed in <sha>", needsCommit: true },
  { id: "noChange", label: "No change needed" },
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

/** "a", "a and b", "a, b and c" — how you'd say it, not how a machine would. */
function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function templateText(
  template: Template,
  commits: LinkTarget[],
  urls: Array<string | null>,
): string {
  const shas = commits.map((c) => c.shortSha);
  // A reply naming several links reads better broken out than run together.
  const links = commits.map((c, i) => urls[i] ?? c.sha);

  switch (template) {
    case "noChange":
      return "Noted — no change needed here, thanks.";
    case "thumbsUp":
      return shas.length > 0 ? `👍 Addressed in ${joinNaturally(shas)}` : "👍";
    case "url":
      if (links.length === 0) return "";
      if (links.length === 1) return `Addressed in ${links[0]}`;
      return `Addressed in:\n${links.map((l) => `- ${l}`).join("\n")}`;
    case "sha":
      return shas.length > 0 ? `Addressed in ${joinNaturally(shas)}` : "";
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
  linkedShas = [],
  draft,
  onDraftChange,
}: {
  repo: RepoInfo;
  pr: PullRequestInfo | null;
  commit: CommitSummary | null;
  threadUrl: string | null;
  /** The commits you linked to this comment, live ones only. */
  linkedShas?: string[];
  /** A previously saved draft for this thread, if any */
  draft?: string | null;
  /** Persist the draft; null clears it. Absent = drafts not saved. */
  onDraftChange?: (text: string | null) => void;
}) {
  // Always your own words by default. The wordings are one click away and
  // the box is seeded from the linked commit, so nothing is lost — but a
  // template selected *for* you is differ deciding what you think, and the
  // one it used to fall back to was "Noted — no change needed here", which
  // is a position on a comment you haven't read yet.
  const [template, setTemplate] = useState<Template>("custom");
  const [custom, setCustom] = useState(draft ?? "");
  /**
   * Whether you've actually typed. Seeded text is a starting point, not a
   * draft — without this, merely opening a comment with a commit linked
   * would save a reply you never wrote and light up "reply drafted".
   */
  const touched = useRef(false);

  const selectedIsReal =
    commit !== null && commit.sha !== WORKING_REV && commit.sha !== BRANCH_REV;

  // What the reply names: every commit you linked, or — before you've linked
  // anything — the change on screen, so the wording is ready when you do.
  const targets = useMemo<LinkTarget[]>(() => {
    if (linkedShas.length > 0)
      return linkedShas.map((sha) => ({ sha, shortSha: sha.slice(0, 7) }));
    return selectedIsReal && commit ? [commit] : [];
  }, [linkedShas, selectedIsReal, commit]);
  const target: LinkTarget | null = targets[0] ?? null;

  const urls = useMemo(
    () => targets.map((t) => buildPrCommitUrl(repo, pr, t.sha)),
    [repo, pr, targets],
  );
  const url = urls[0] ?? null;

  const generated = templateText(template, targets, urls);
  const text = template === "custom" ? custom : generated;

  // Seed the custom box from whatever was last generated, so switching to
  // "write my own" is an edit rather than a blank page. Only before you've
  // typed: seeding a box you deliberately emptied puts words back that you
  // just took out, and the save below would then store them as your draft.
  useEffect(() => {
    if (template === "custom" && !custom && !touched.current) {
      setCustom(templateText("url", targets, urls));
    }
  }, [template, custom, targets, urls]);

  // Persist the draft, debounced — the point is that it survives a reload,
  // a collapse, or switching commits, not that every keystroke hits disk.
  // The saved value is compared against so a session refresh echoing the
  // draft back can't trigger a pointless write.
  const savedRef = useRef(draft ?? "");
  useEffect(() => {
    savedRef.current = draft ?? "";
  }, [draft]);

  /**
   * Hand the current text up, now, if it isn't already saved.
   *
   * Reads through a ref rather than closing over the render's values, so the
   * unmount cleanup below — which runs once, long after the render that
   * registered it — still flushes the latest keystroke rather than a stale one.
   */
  const latest = useRef({ custom, onDraftChange });
  useEffect(() => {
    latest.current = { custom, onDraftChange };
  });

  const flush = useCallback(() => {
    const { custom: text, onDraftChange: save } = latest.current;
    if (!save || !touched.current) return;
    if (text === savedRef.current) return;
    savedRef.current = text;
    save(text.trim() === "" ? null : text);
  }, []);

  useEffect(() => {
    if (!onDraftChange || template !== "custom") return;
    if (!touched.current) return;
    if (custom === savedRef.current) return;

    const timer = setTimeout(flush, 600);
    return () => clearTimeout(timer);
  }, [custom, template, onDraftChange, flush]);

  /**
   * The last 600ms of typing, saved rather than dropped.
   *
   * This box is keyed on the thread, so stepping to the next comment unmounts
   * it — and a pending debounce timer dies with it. That is exactly how a
   * reply typed and immediately stepped away from used to disappear. The same
   * goes for the window being hidden or closed mid-sentence; the write itself
   * is `keepalive`, so it survives the page going away.
   *
   * Deliberately not gated on the template: if you typed your own words and
   * then clicked a wording, the words are still yours and still kept.
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  // No commit linked, so the templates that name one have nothing to say.
  // The box stays open regardless: you can always write a reply, and most
  // comments are answered without a commit at all.
  const commitTemplatesDisabled = targets.length === 0;

  // Unlinking a commit while an "Addressed in <sha>" template is selected
  // would otherwise leave an empty box that looks broken. Back to your own
  // words, not to a stance differ picked.
  if (
    commitTemplatesDisabled &&
    (template === "url" || template === "sha" || template === "thumbsUp")
  )
    setTemplate("custom");

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border-muted)] px-2 py-1.5">
        {TEMPLATES.map((option) => {
          const disabled = Boolean(
            option.needsCommit && commitTemplatesDisabled,
          );
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              title={disabled ? "Link a commit to use this wording" : undefined}
              onClick={() => setTemplate(option.id)}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                template === option.id
                  ? "bg-[var(--accent-subtle)] text-[var(--accent)]"
                  : "text-[var(--fg-muted)] hover:bg-[var(--canvas-subtle)]"
              } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <>
        <p className="flex flex-wrap items-center gap-x-2 border-b border-[var(--border-muted)] bg-[var(--canvas-subtle)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">
          {/* The card above already names the linked commits; saying it
                again here was the same fact twice in adjacent boxes. */}
          {linkedShas.length > 0 ? null : target ? (
            <>
              Drafting against <span className="mono">{target.shortSha}</span>,
              the change on screen.
            </>
          ) : (
            <span className="text-[var(--fg-muted)]">
              No commit linked — the wordings above that name one are off.
            </span>
          )}

          <span className="flex-1" />
        </p>
        <textarea
          value={text}
          readOnly={template !== "custom"}
          onChange={(event) => {
            touched.current = true;
            setCustom(event.target.value);
          }}
          rows={template === "custom" ? 3 : 2}
          className={`mono w-full resize-y bg-transparent px-3 py-2 text-[12px] leading-5 outline-none ${
            template === "custom" ? "" : "text-[var(--fg-muted)]"
          }`}
        />

        <div className="flex items-center gap-2 border-t border-[var(--border-muted)] px-2 py-1.5">
          <CopyButton value={text} label="Copy reply" />
          {threadUrl && (
            <a
              href={threadUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[var(--accent)] hover:underline"
            >
              Open thread <LinkExternalIcon size={12} />
            </a>
          )}

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
                touched.current = false;
                onDraftChange(null);
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
