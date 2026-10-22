"use client";

import { useState } from "react";

import type { Note } from "@/lib/types";
import { sinceLabel, TickCheck, TickRing, useTickPulse } from "./Tick";
import { Button } from "./ui";

/** The tick on a sent note: the small square version of the review tick. */
export function NoteTick({
  done,
  onToggle,
}: {
  done: boolean;
  onToggle: (next: boolean) => void;
}) {
  const pulse = useTickPulse(done);
  return (
    <button
      type="button"
      onClick={() => onToggle(!done)}
      aria-pressed={done}
      title={done ? "Handled — click to reopen" : "Mark as handled"}
      className={`tick-spring relative mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
        done
          ? "border-[var(--handled)] bg-[var(--handled)] text-white"
          : "border-[var(--border)] bg-[var(--canvas)] text-transparent hover:border-[var(--handled)]"
      }`}
    >
      <span key={pulse} className={pulse > 0 && done ? "tick-pop" : undefined}>
        <TickCheck size={11} pulse={pulse} />
      </span>
      <TickRing pulse={done ? pulse : 0} />
    </button>
  );
}

/**
 * Write or edit a note. ⌘/Ctrl-Enter saves and Escape cancels, so a note can
 * be dashed off without leaving the keyboard.
 */
export function NoteComposer({
  initial = "",
  placeholder = "What should change here?",
  onSave,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  // A note left at its starting text, such as "On Sync Engine:", says nothing.
  const canSave = text.trim().length > 0 && text.trim() !== initial.trim();

  return (
    <div className="rounded-md border border-[var(--accent)] bg-[var(--canvas)]">
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            canSave
          ) {
            event.preventDefault();
            onSave(text);
          }
        }}
        rows={3}
        placeholder={placeholder}
        className="w-full resize-y rounded-t-md bg-transparent px-3 py-2 font-sans text-[13px] leading-5 outline-none"
      />
      <div className="flex items-center justify-end gap-2 border-t border-[var(--border-muted)] px-2 py-1.5">
        <span className="mr-auto text-[11px] text-[var(--fg-subtle)]">
          ⌘↵ to save · esc to cancel
        </span>
        <Button size="sm" variant="invisible" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!canSave}
          onClick={() => onSave(text)}
        >
          Save note
        </Button>
      </div>
    </div>
  );
}

/**
 * A saved note. A draft is editable in place; a sent one is what the agent
 * read, so it's fixed, and gets a tick instead.
 */
export function NoteCard({
  note,
  onSave,
  onRemove,
  onTick,
  context,
}: {
  note: Note;
  onSave: (note: Note) => void;
  onRemove: (id: string) => void;
  onTick: (id: string, done: boolean) => void;
  /** Shown above the body, e.g. where a note that lost its line used to be */
  context?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <NoteComposer
        initial={note.body}
        onCancel={() => setEditing(false)}
        onSave={(body) => {
          onSave({ ...note, body });
          setEditing(false);
        }}
      />
    );
  }

  const sent = note.sentAt !== null;

  return (
    <div
      id={`note-${note.id}`}
      className={`group rounded-md border bg-[var(--canvas)] px-3 py-2 font-sans ${
        sent ? "border-[var(--border-muted)]" : "border-[var(--border)]"
      } ${note.done ? "opacity-60" : ""}`}
      style={{ scrollMarginTop: "calc(var(--header-height, 0px) + 48px)" }}
    >
      {context && (
        <div className="mb-1 text-[11px] text-[var(--fg-muted)]">{context}</div>
      )}
      <div className="flex items-start gap-2">
        {sent && (
          <NoteTick
            done={note.done}
            onToggle={(done) => onTick(note.id, done)}
          />
        )}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-5">
          {note.body}
        </p>
        {sent && (
          <span className="shrink-0 pt-[2px] text-[11px] text-[var(--fg-subtle)]">
            sent {sinceLabel(note.sentAt!)}
          </span>
        )}
        <div className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100">
          {!sent && (
            <Button
              size="sm"
              variant="invisible"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="invisible"
            onClick={() => onRemove(note.id)}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
