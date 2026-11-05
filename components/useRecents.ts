"use client";

import { useCallback, useEffect, useState } from "react";

import {
  loadRecents,
  removeFromList,
  saveRecents,
  touchList,
  type RecentRepo,
} from "@/lib/recents";

/** Previously opened repos for the RepoBar dropdown, kept in localStorage. */
export function useRecents() {
  const [list, setList] = useState<RecentRepo[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setList(loadRecents());
  }, []);

  const touch = useCallback((path: string, branch: string | null) => {
    setList((current) => {
      const next = touchList(current, { path, branch }, Date.now());
      saveRecents(next);
      return next;
    });
  }, []);

  const remove = useCallback((path: string) => {
    setList((current) => {
      const next = removeFromList(current, path);
      saveRecents(next);
      return next;
    });
  }, []);

  return { list, touch, remove };
}
