"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { NOTES_API } from "@/lib/constants";
import type { ApiError, Note } from "@/lib/types";

export interface NotesApi {
  notes: Note[];
  error: string | null;
  save: (note: Note) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * The notes for one checkout, held in the window and mirrored to the store.
 *
 * Writes are optimistic — a note appears the instant you save it — and the
 * server's answer then replaces the local copy, so the file stays the source
 * of truth. A failed write refetches rather than trying to undo by hand.
 */
export function useNotes(root: string): NotesApi {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Answers can land out of order; only the newest request's is kept.
  const seq = useRef(0);

  const url = `${NOTES_API}?${new URLSearchParams({ repo: root })}`;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error((data as ApiError).error);
      if (mine === seq.current) {
        setNotes((data as { notes: Note[] }).notes);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [url]);

  useEffect(() => {
    setNotes([]);
    void load();
  }, [load]);

  const send = useCallback(
    async (body: object) => {
      const mine = ++seq.current;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) throw new Error((data as ApiError).error);
        if (mine === seq.current) {
          setNotes((data as { notes: Note[] }).notes);
          setError(null);
        }
      } catch (err) {
        setError(
          `Couldn't save notes: ${err instanceof Error ? err.message : String(err)}`,
        );
        void load();
      }
    },
    [url, load],
  );

  const save = useCallback(
    (note: Note) => {
      setNotes((prev) =>
        prev.some((n) => n.id === note.id)
          ? prev.map((n) => (n.id === note.id ? note : n))
          : [...prev, note],
      );
      void send({ save: note });
    },
    [send],
  );

  const remove = useCallback(
    (id: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== id));
      void send({ remove: id });
    },
    [send],
  );

  const clear = useCallback(() => {
    setNotes([]);
    void send({ clear: true });
  }, [send]);

  return { notes, error, save, remove, clear };
}
