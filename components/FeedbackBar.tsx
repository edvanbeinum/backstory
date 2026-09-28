"use client";

import { useEffect, useMemo, useState } from "react";

import { fileForNote, formatFeedback } from "@/lib/feedback";
import type { DiffResponse } from "@/lib/types";
import { CommentIcon } from "./icons";
import { NoteCard, NoteComposer } from "./NoteCard";
import { Button, CopyButton } from "./ui";
import type { NotesApi } from "./useNotes";

/**
 * The notes you've left on your uncommitted work, and the way out for them.
 *
 * Like replies, notes leave differ only via the clipboard: "Copy for agent"
 * turns them into one markdown message to paste into whatever session is
 * making the change. Line notes live on their lines in the diff below; this
 * holds the ones that have nowhere else to go — general notes, and notes on a
 * file that's no longer changed at all.
 */
export function FeedbackBar({
  notes,
  diff,
}: {
  notes: NotesApi;
  diff: DiffResponse | null;
}) {
  const [writing, setWriting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const files = useMemo(() => diff?.files ?? [], [diff]);
  const general = notes.notes.filter((n) => !n.path);
  // Only judged once the diff is in, or every note would flash as orphaned.
  const orphaned = diff
    ? notes.notes.filter((n) => n.path && !fileForNote(files, n))
    : [];
  const count = notes.notes.length;

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = setTimeout(() => setConfirmingClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-2">
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
              label="Copy for agent"
              title="Copy every note as one markdown message to paste into an agent session"
              variant="primary"
            />
          )}
        </div>
      </div>

      {notes.error && (
        <p className="text-[12px] text-[var(--danger)]">{notes.error}</p>
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
