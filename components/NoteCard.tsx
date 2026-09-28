"use client";

import { useState } from "react";

import type { Note } from "@/lib/types";
import { Button } from "./ui";

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
  const canSave = text.trim().length > 0;

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

/** A saved note, editable in place. */
export function NoteCard({
  note,
  onSave,
  onRemove,
  context,
}: {
  note: Note;
  onSave: (note: Note) => void;
  onRemove: (id: string) => void;
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

  return (
    <div className="group rounded-md border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 font-sans">
      {context && (
        <div className="mb-1 text-[11px] text-[var(--fg-muted)]">{context}</div>
      )}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-5">
          {note.body}
        </p>
        <div className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100">
          <Button size="sm" variant="invisible" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="invisible" onClick={() => onRemove(note.id)}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
