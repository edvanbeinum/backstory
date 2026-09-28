"use client";

import { useEffect, useMemo, useState } from "react";

import { draftNote, fileForNote, formatFeedback } from "@/lib/feedback";
import type { DiffFile, DiffResponse, Note } from "@/lib/types";
import { CheckIcon, CommentIcon, CopyIcon } from "./icons";
import { NoteCard, NoteComposer, NoteTick } from "./NoteCard";
import { sinceLabel } from "./Tick";
import { Button, copyToClipboard } from "./ui";
import type { NotesApi } from "./useNotes";
import type { ReviewApi } from "./useReview";

/**
 * The notes you've left on your uncommitted work, and the way out for them.
 *
 * Drafts leave either by the clipboard ("Copy for agent") or, when an agent
 * is waiting on `differ review`, straight to it. Either way they become a
 * round: fixed, since that's what the agent read, and each with a tick that
 * only you set once you've seen it handled. That's the same checklist differ
 * keeps for review comments, with you as the reviewer.
 *
 * Line notes live on their lines in the diff below. This holds the ones with
 * nowhere else to go — general notes, and notes on a file that no longer has
 * uncommitted changes — and lists every round, so an open note can't slip
 * away just because its line did.
 */
export function FeedbackBar({
  notes,
  diff,
  review,
  onShowUncommitted,
}: {
  notes: NotesApi;
  /** The uncommitted diff, or null when another change is showing */
  diff: DiffResponse | null;
  review: ReviewApi;
  /** Set when an agent is waiting but the uncommitted diff isn't showing */
  onShowUncommitted: (() => void) | null;
}) {
  const [writing, setWriting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const drafts = notes.notes.filter((n) => n.sentAt === null);
  const rounds = useMemo(() => groupRounds(notes.notes), [notes.notes]);
  const handled = notes.notes.filter((n) => n.done).length;

  const general = drafts.filter((n) => !n.path);
  // Only judged once the diff is in, or every note would flash as orphaned.
  const orphaned = diff
    ? drafts.filter((n) => n.path && !fileForNote(files, n))
    : [];
  const count = drafts.length;

  const handOver = () =>
    notes.send(
      drafts.map((n) => n.id),
      Date.now(),
    );

  const sendToAgent = async () => {
    setSending(true);
    const answer =
      count > 0
        ? formatFeedback(drafts, files)
        : "No changes requested — the uncommitted changes look good.\n";
    if ((await review.send(answer)) && count > 0) handOver();
    setSending(false);
  };

  const copyForAgent = async () => {
    if (await copyToClipboard(formatFeedback(drafts, files))) {
      handOver();
      setCopied(true);
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

  // Another change is on screen: notes are sent as they sit on the
  // uncommitted diff, so that's where sending happens.
  if (!diff) {
    if (!review.waiting && !review.error) return null;
    return (
      <div className="space-y-2 rounded-md border border-[var(--accent)] bg-[var(--accent-subtle)] px-3 py-2 shadow-lg">
        {review.waiting && (
          <div className="flex flex-wrap items-center gap-2">
            <CommentIcon size={14} className="text-[var(--accent)]" />
            <span className="text-[13px] font-medium">
              An agent is waiting for your review
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="invisible" onClick={() => void review.dismiss()}>
                Dismiss
              </Button>
              {onShowUncommitted && (
                <Button size="sm" variant="primary" onClick={onShowUncommitted}>
                  Review uncommitted changes
                </Button>
              )}
            </div>
          </div>
        )}
        {review.error && (
          <p className="text-[12px] text-[var(--danger)]">{review.error}</p>
        )}
      </div>
    );
  }

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
          An agent is waiting for your review of these changes. Leave notes
          on the lines, then send them — or let it carry on.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CommentIcon size={14} className="text-[var(--accent)]" />
        <span className="text-[13px] font-medium">
          {count === 0
            ? "Notes for your agent"
            : `${count} ${count === 1 ? "note" : "notes"} for your agent`}
        </span>
        {count === 0 && (
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
      {review.error && (
        <p className="text-[12px] text-[var(--danger)]">
          {review.error} Your notes are still here.
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
              — that file has no uncommitted changes any more.
            </>
          }
        />
      ))}

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
              draftNote({ path: null, side: "new", line: null, quote: null, body }),
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
              files={files}
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
  files,
  onTick,
}: {
  round: RoundGroup;
  files: DiffFile[];
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
                    onClick={() => jumpTo(note, files)}
                    className="mono mr-1.5 text-[11px] text-[var(--accent)] hover:underline"
                  >
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

/** Scroll to the note on its line, or failing that, to its file. */
function jumpTo(note: Note, files: DiffFile[]) {
  const file = fileForNote(files, note);
  const target =
    document.getElementById(`note-${note.id}`) ??
    (file ? document.getElementById(`file-${encodeURIComponent(file.path)}`) : null);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}
