/**
 * Recently-opened repos, for the dropdown on the repo input. Stored in
 * localStorage — this is per-browser UI state, same as the current repo.
 *
 * The list logic is pure (testable without a DOM); only load/save touch
 * storage.
 */

export interface RecentRepo {
  path: string;
  branch: string | null;
  /** Last opened, ms epoch — the list is ordered by this, newest first */
  at: number;
}

const KEY = "differ.recentRepos";
const MAX = 12;

/** Most-recent-first, deduped by path, capped. */
export function touchList(
  list: RecentRepo[],
  entry: { path: string; branch: string | null },
  now: number,
): RecentRepo[] {
  const rest = list.filter((r) => r.path !== entry.path);
  return [{ ...entry, at: now }, ...rest].slice(0, MAX);
}

export function removeFromList(list: RecentRepo[], path: string): RecentRepo[] {
  return list.filter((r) => r.path !== path);
}

export function loadRecents(): RecentRepo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRepo =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as RecentRepo).path === "string" &&
        typeof (r as RecentRepo).at === "number",
    );
  } catch {
    return [];
  }
}

export function saveRecents(list: RecentRepo[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage full or blocked — recents are a convenience, not state
  }
}
