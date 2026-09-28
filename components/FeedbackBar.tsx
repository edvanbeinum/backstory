"use client";

import { useEffect, useMemo, useState } from "react";

import { BRANCH_REV, DIFF_API, WORKING_REV } from "@/lib/constants";
import {
  draftNote,
  fileForNote,
  formatFeedback,
  type NoteCommit,
} from "@/lib/feedback";
import type {
  DiffFile,
  DiffResponse,
  Note,
  SessionResponse,
} from "@/lib/types";
import { pushedState } from "@/lib/pushed";
import { CheckIcon, CommentIcon, CopyIcon, XIcon } from "./icons";
import { NoteCard, NoteComposer, NoteTick } from "./NoteCard";
import { sinceLabel } from "./Tick";
import { Button, copyToClipboard } from "./ui";
import type { NotesApi } from "./useNotes";
import type { ReviewApi } from "./useReview";

/**
 * The notes you've left on this branch's changes, and the way out for them.
 *
 * Notes go on any change — a commit, the branch as a whole, uncommitted work
 * — so a stack of an agent's commits can be reviewed one at a time and sent
 * in one go. Drafts leave either by the clipboard ("Copy for agent") or, when
 * an agent is waiting on `differ review`, straight to it. Either way they
 * become a round: fixed, since that's what the agent read, and each with a
 * tick that only you set once you've seen it handled.
 *
 * Line notes live on their lines in the diff. This holds the rest — general
 * notes, notes on a file this change no longer touches, and drafts left on
 * other changes — and lists every round, so an open note can't slip away just
 * because its line did.
 */
export function FeedbackBar({
  notes,
  noteRev,
  diff,
  session,
  review,
  onRevChange,
}: {
  notes: NotesApi;
  /** The change on screen, as notes record it; null while it loads */
  noteRev: string | null;
  /** That change's diff, once it's the one showing */
  diff: DiffResponse | null;
  session: SessionResponse;
  review: ReviewApi;
  onRevChange: (rev: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const commits = useMemo(() => branchCommits(session), [session]);
  const drafts = notes.notes.filter((n) => n.sentAt === null);
  const rounds = useMemo(() => groupRounds(notes.notes), [notes.notes]);
  const handled = notes.notes.filter((n) => n.done).length;

  const general = drafts.filter((n) => !n.path);
  const here = drafts.filter((n) => n.path && n.rev === noteRev);
  const elsewhere = drafts.filter((n) => n.path && n.rev !== noteRev);
  // Only judged once the diff is in, or every note would flash as orphaned.
  const orphaned = diff ? here.filter((n) => !fileForNote(files, n)) : [];
  const count = drafts.length;

  const label = (rev: string) => changeLabel(rev, commits);

  /**
   * The message, with every note placed against its own change. Uncommitted
   * work and the branch diff move, so theirs are fetched fresh if they aren't
   * the one on screen; a commit's lines can't move, so commits never are.
   */
  const buildMessage = async (): Promise<string> => {
    const diffs = new Map<string, DiffFile[]>();
    if (noteRev && diff) diffs.set(noteRev, diff.files);

    const moving = [
      ...new Set(
        drafts
          .map((n) => n.rev)
          .filter((r) => (r === WORKING_REV || r === BRANCH_REV) && !diffs.has(r)),
      ),
    ];
    await Promise.all(
      moving.map(async (rev) => {
        const params = new URLSearchParams({ repo: session.repo.root, rev });
        const response = await fetch(`${DIFF_API}?${params}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Couldn't load ${label(rev)}.`);
        diffs.set(rev, ((await response.json()) as DiffResponse).files);
      }),
    );

    return formatFeedback(drafts, { diffs, commits });
  };

  const handOver = () =>
    notes.send(
      drafts.map((n) => n.id),
      Date.now(),
    );

  const sendToAgent = async () => {
    setSending(true);
    setSendError(null);
    try {
      const answer =
        count > 0
          ? await buildMessage()
          : "No changes requested — this looks good.\n";
      if ((await review.send(answer)) && count > 0) handOver();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const copyForAgent = async () => {
    setSendError(null);
    try {
      if (await copyToClipboard(await buildMessage())) {
        handOver();
        setCopied(true);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = setTimeout(() => setConfirmingClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  /** Scroll to a note on screen, or switch to the change it was left on. */
  const jumpTo = (note: Note) => {
    if (note.rev !== noteRev) {
      onRevChange(note.rev);
      return;
    }
    const file = fileForNote(files, note);
    const target =
      document.getElementById(`note-${note.id}`) ??
      (file ? document.getElementById(`file-${encodeURIComponent(file.path)}`) : null);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div
      className={`space-y-2 rounded-md border px-3 py-2 shadow-lg ${
        review.waiting
          ? "border-[var(--accent)] bg-[var(--accent-subtle)]"
          : "border-[var(--border)] bg-[var(--canvas)]"
      }`}
    >
      {review.waiting && (
        <p className="text-[12px] text-[var(--fg-muted)]">
          An agent is waiting for your review. Leave notes on any change —
          its commits, or what&apos;s uncommitted — then send them, or let it
          carry on.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CommentIcon size={14} className="text-[var(--accent)]" />
        <span className="text-[13px] font-medium">
          {count === 0
            ? "Notes for your agent"
            : `${count} ${count === 1 ? "note" : "notes"} for your agent`}
        </span>
        {count === 0 && noteRev && (
          <span className="text-[12px] text-[var(--fg-muted)]">
            — hover a line and press + to leave one
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {!writing && (
            <Button size="sm" variant="invisible" onClick={() => setWriting(true)}>
              Add a general note
            </Button>
          )}
          {count > 0 &&
            (confirmingClear ? (
              <Button
                size="sm"
                onClick={() => {
                  notes.clearDrafts();
                  setConfirmingClear(false);
                }}
                className="!border-[var(--danger)] !text-[var(--danger)]"
              >
                Clear {count}?
              </Button>
            ) : (
              <Button
                size="sm"
                variant="invisible"
                title="Delete every note you haven't sent"
                onClick={() => setConfirmingClear(true)}
              >
                Clear
              </Button>
            ))}
          {(count > 0 || copied) && (
            <Button
              size="sm"
              variant={review.waiting ? "default" : "primary"}
              disabled={copied}
              onClick={() => void copyForAgent()}
              title="Copy the notes as one markdown message to paste into an agent session. They move into a sent round."
            >
              {copied ? (
                <CheckIcon size={14} className="text-[var(--success)]" />
              ) : (
                <CopyIcon size={14} />
              )}
              {copied ? "Copied" : review.waiting ? "Copy" : "Copy for agent"}
            </Button>
          )}
          {review.waiting && count > 0 && (
            <Button size="sm" variant="invisible" onClick={() => void review.dismiss()}>
              Dismiss
            </Button>
          )}
          {review.waiting && (
            <Button
              size="sm"
              variant="primary"
              disabled={sending}
              onClick={() => void sendToAgent()}
              title={
                count > 0
                  ? "Send the notes to the waiting agent. They move into a sent round."
                  : "Tell the waiting agent there's nothing to change"
              }
            >
              {count > 0
                ? `Send ${count} ${count === 1 ? "note" : "notes"} to agent`
                : "Looks good"}
            </Button>
          )}
        </div>
      </div>

      {notes.error && (
        <p className="text-[12px] text-[var(--danger)]">{notes.error}</p>
      )}
      {(review.error || sendError) && (
        <p className="text-[12px] text-[var(--danger)]">
          {review.error ?? sendError} Your notes are still here.
        </p>
      )}

      <div className="thin-scroll max-h-[45vh] space-y-2 overflow-y-auto">
        {orphaned.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            onSave={notes.save}
            onRemove={notes.remove}
            onTick={notes.tick}
            context={
              <>
                <span className="mono">
                  {note.path}:{note.line}
                </span>{" "}
                —{" "}
                {note.rev === WORKING_REV
                  ? "that file has no uncommitted changes any more."
                  : "that file isn't in this change any more."}
              </>
            }
          />
        ))}

        {elsewhere.length > 0 && (
          <div>
            <p className="text-[12px] font-medium text-[var(--fg-muted)]">
              On other changes
            </p>
            <ul className="mt-1 space-y-1">
              {elsewhere.map((note) => (
                <li key={note.id} className="group flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => jumpTo(note)}
                      title={`Show ${label(note.rev)}`}
                      className="mono mr-1.5 text-[11px] text-[var(--accent)] hover:underline"
                    >
                      {label(note.rev)} · {note.path}:{note.line}
                    </button>
                    <span className="line-clamp-2 whitespace-pre-wrap text-[12px]">
                      {note.body}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label="Delete note"
                    title="Delete note"
                    onClick={() => notes.remove(note.id)}
                    className="shrink-0 text-[var(--fg-subtle)] opacity-0 hover:text-[var(--fg)] group-hover:opacity-100"
                  >
                    <XIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {general.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            onSave={notes.save}
            onRemove={notes.remove}
            onTick={notes.tick}
          />
        ))}

        {writing && (
          <NoteComposer
            placeholder="Anything about the change as a whole?"
            onCancel={() => setWriting(false)}
            onSave={(body) => {
              notes.save(
                draftNote({
                  rev: noteRev ?? WORKING_REV,
                  path: null,
                  side: "new",
                  line: null,
                  quote: null,
                  body,
                }),
              );
              setWriting(false);
            }}
          />
        )}

        {rounds.length > 0 && (
          <div className="space-y-2 border-t border-[var(--border-muted)] pt-2">
            {rounds.map((round) => (
              <Round
                key={round.sentAt}
                round={round}
                label={label}
                noteRev={noteRev}
                onJump={jumpTo}
                onTick={notes.tick}
              />
            ))}
            {handled > 0 && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="invisible"
                  title="Forget every sent note you've ticked"
                  onClick={notes.clearDone}
                >
                  Clear {handled} handled
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The branch's commits oldest first — the order the work happened in, and so
 * the order the message reads.
 */
function branchCommits(session: SessionResponse): NoteCommit[] {
  return [...session.history, ...session.commits]
    .reverse()
    .map(({ sha, subject }) => ({
      sha,
      subject,
      pushed: pushedState(session, sha),
    }));
}

function changeLabel(rev: string, commits: NoteCommit[]): string {
  if (rev === WORKING_REV) return "Uncommitted";
  if (rev === BRANCH_REV) return "All changes";
  return rev.slice(0, 7) + (commits.some((c) => c.sha === rev) ? "" : " (gone)");
}

interface RoundGroup {
  sentAt: number;
  notes: Note[];
}

/** Sent notes grouped by when they went, newest round first. */
function groupRounds(notes: Note[]): RoundGroup[] {
  const byTime = new Map<number, Note[]>();
  for (const note of notes) {
    if (note.sentAt === null) continue;
    byTime.set(note.sentAt, [...(byTime.get(note.sentAt) ?? []), note]);
  }
  return [...byTime.entries()]
    .map(([sentAt, list]) => ({ sentAt, notes: list }))
    .sort((a, b) => b.sentAt - a.sentAt);
}

/**
 * One round as a checklist. A fully handled round folds to its header — a
 * list of done things is noise — but stays until you clear it.
 */
function Round({
  round,
  label,
  noteRev,
  onJump,
  onTick,
}: {
  round: RoundGroup;
  label: (rev: string) => string;
  noteRev: string | null;
  onJump: (note: Note) => void;
  onTick: (id: string, done: boolean) => void;
}) {
  const done = round.notes.filter((n) => n.done).length;
  const total = round.notes.length;
  const complete = done === total;
  const [open, setOpen] = useState(!complete);

  useEffect(() => {
    if (complete) setOpen(false);
  }, [complete]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <span className="font-medium">Sent {sinceLabel(round.sentAt)}</span>
        <span className={complete ? "text-[var(--handled)]" : ""}>
          · {done} of {total} handled
        </span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {round.notes.map((note) => (
            <li key={note.id} className="flex items-start gap-2">
              <NoteTick done={note.done} onToggle={(d) => onTick(note.id, d)} />
              <div className={`min-w-0 flex-1 ${note.done ? "opacity-60" : ""}`}>
                {note.path && (
                  <button
                    type="button"
                    onClick={() => onJump(note)}
                    className="mono mr-1.5 text-[11px] text-[var(--accent)] hover:underline"
                  >
                    {note.rev !== noteRev && `${label(note.rev)} · `}
                    {note.path}
                    {note.line !== null ? `:${note.line}` : ""}
                  </button>
                )}
                <span className="line-clamp-2 whitespace-pre-wrap text-[12px]">
                  {note.body}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
