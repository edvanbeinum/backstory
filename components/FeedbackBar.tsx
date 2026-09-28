"use client";

import { useEffect, useMemo, useState } from "react";

import { fileForNote, formatFeedback } from "@/lib/feedback";
import type { DiffResponse } from "@/lib/types";
import { CommentIcon } from "./icons";
import { NoteCard, NoteComposer } from "./NoteCard";
import { Button, CopyButton } from "./ui";
import type { NotesApi } from "./useNotes";
import type { ReviewApi } from "./useReview";

/**
 * The notes you've left on your uncommitted work, and the way out for them.
 *
 * Like replies, notes leave differ only via the clipboard: "Copy for agent"
 * turns them into one markdown message to paste into whatever session is
 * making the change. Line notes live on their lines in the diff below; this
 * holds the ones that have nowhere else to go — general notes, and notes on a
 * file that's no longer changed at all.
 *
 * When an agent is waiting on `differ review`, the bar also offers to send the
 * notes straight to it. Sending clears them: they've been handed over, and the
 * agent's next edit will move every line they point at anyway.
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

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const general = notes.notes.filter((n) => !n.path);
  // Only judged once the diff is in, or every note would flash as orphaned.
  const orphaned = diff
    ? notes.notes.filter((n) => n.path && !fileForNote(files, n))
    : [];
  const count = notes.notes.length;

  const sendToAgent = async () => {
    setSending(true);
    const answer =
      count > 0
        ? formatFeedback(notes.notes, files)
        : "No changes requested — the uncommitted changes look good.\n";
    if (await review.send(answer)) notes.clear();
    setSending(false);
  };

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
      <div className="space-y-2 rounded-md border border-[var(--accent)] bg-[var(--accent-subtle)] px-3 py-2">
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
      className={`space-y-2 rounded-md border px-3 py-2 ${
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
                  notes.clear();
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
                title="Delete every note on these changes"
                onClick={() => setConfirmingClear(true)}
              >
                Clear
              </Button>
            ))}
          {count > 0 && (
            <CopyButton
              value={() => formatFeedback(notes.notes, files)}
              label={review.waiting ? "Copy" : "Copy for agent"}
              title="Copy every note as one markdown message to paste into an agent session"
              variant={review.waiting ? "default" : "primary"}
            />
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
                  ? "Send every note to the waiting agent, then clear them"
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

      {orphaned.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          onSave={notes.save}
          onRemove={notes.remove}
          context={
            <>
              <span className="mono">
                {note.path}:{note.line}
              </span>{" "}
              — that file isn&apos;t in the uncommitted changes any more.
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
        />
      ))}

      {writing && (
        <NoteComposer
          placeholder="Anything about the change as a whole?"
          onCancel={() => setWriting(false)}
          onSave={(body) => {
            notes.save({
              id: crypto.randomUUID(),
              path: null,
              side: "new",
              line: null,
              quote: null,
              body,
              createdAt: Date.now(),
            });
            setWriting(false);
          }}
        />
      )}
    </div>
  );
}
