"use client";

import { useCallback, useEffect, useState } from "react";

import { INBOX_ROOTS_KEY } from "@/lib/constants";
import { loadRecents } from "@/lib/recents";

function save(repos: string[]) {
  try {
    window.localStorage.setItem(INBOX_ROOTS_KEY, JSON.stringify(repos));
  } catch {
    // Storage full or blocked: the inbox rescans from recents.
  }
}

/**
 * The repos the inbox scans, kept in localStorage.
 *
 * Not the recents list: that holds *worktree* paths capped at twelve, so with
 * twenty worktrees it fills up with one repo and quietly evicts the other. The
 * inbox reports the canonical root of everything it finds, and those get
 * written back here, so twelve volatile worktree paths converge to two stable
 * repo roots after one load.
 */
export function useInboxRepos() {
  const [repos, setRepos] = useState<string[]>([]);

  useEffect(() => {
    const seeds = loadRecents().map((r) => r.path);
    let known: string[] = [];
    try {
      const raw = window.localStorage.getItem(INBOX_ROOTS_KEY);
      const stored = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(stored))
        known = stored.filter((v): v is string => typeof v === "string");
    } catch {
      // Unreadable: the recents alone seed the list.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setRepos([...new Set([...known, ...seeds])]);
  }, []);

  const remember = useCallback((root: string) => {
    setRepos((current) => {
      if (current.includes(root)) return current;
      const next = [...current, root];
      save(next);
      return next;
    });
  }, []);

  const forget = useCallback((roots: string[]) => {
    const drop = new Set(roots);
    setRepos((current) => {
      const next = current.filter((r) => !drop.has(r));
      save(next);
      return next;
    });
  }, []);

  return { repos, remember, forget };
}
