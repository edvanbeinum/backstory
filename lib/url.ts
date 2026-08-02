import { BRANCH_REV, WORKING_REV } from "./constants";
import type { CommitSummary } from "./types";

/**
 * The bit of app state that lives in the address bar, so a view can be
 * bookmarked, reopened after a restart, or pasted to another machine with the
 * same checkout.
 *
 * This uses the History API directly rather than Next's router: the page is a
 * statically prerendered client component, and `useSearchParams` would drag it
 * into a Suspense boundary for no benefit here.
 */
export interface UrlState {
  repo: string | null;
  rev: string | null;
}

/** Pure half of readUrlState, so it can be tested without a DOM. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const repo = params.get("repo")?.trim();
  const rev = params.get("rev")?.trim();

  return {
    repo: repo ? repo : null,
    rev: rev ? rev : null,
  };
}

export function buildUrl(state: UrlState, pathname = "/"): string {
  const params = new URLSearchParams();
  if (state.repo) params.set("repo", state.repo);
  // `working` is the default landing spot; leaving it out keeps the common
  // URL short, and a missing rev falls back to it anyway.
  if (state.rev && state.rev !== WORKING_REV) params.set("rev", state.rev);

  // URLSearchParams percent-encodes slashes, which turns every repo path into
  // an unreadable %2F soup. A slash is legal unencoded in a query string, and
  // parsing only ever splits on & and =, so putting them back is safe and
  // makes the URL something you can actually read. Everything else — &, =, #,
  // spaces — stays encoded.
  const query = params.toString().replace(/%2F/g, "/");
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function readUrlState(): UrlState {
  if (typeof window === "undefined") return { repo: null, rev: null };
  return parseUrlState(window.location.search);
}

/**
 * Replace rather than push. Moving between commits with j/k would otherwise
 * bury the previous page under dozens of history entries, and the URL only
 * needs to be *current*, not a trail.
 */
export function writeUrlState(state: UrlState) {
  if (typeof window === "undefined") return;

  const next = buildUrl(state, window.location.pathname);
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) {
    window.history.replaceState(null, "", next);
  }
}

export interface RevResolution {
  rev: string;
  /** The rev that was asked for but isn't available, if any. */
  notice: string | null;
}

/**
 * Decide which rev to show, given what a URL (or the previous session) asked
 * for and what the repo actually has.
 *
 * A rev from a URL may be a short sha someone typed by hand, so match on
 * prefix and normalise to the full one — that keeps the commit lookup, the
 * reply links and the URL itself all agreeing. A rev that's gone entirely,
 * usually because it has since been pushed, falls back but says so rather
 * than silently showing a different commit.
 */
export function resolveRev(
  requested: string,
  commits: CommitSummary[],
  hasWorkingChanges: boolean,
  hasBranchDiff = false,
): RevResolution {
  const fallback = hasWorkingChanges
    ? WORKING_REV
    : (commits[0]?.sha ?? WORKING_REV);

  if (requested === WORKING_REV) {
    return hasWorkingChanges
      ? { rev: WORKING_REV, notice: null }
      : { rev: fallback, notice: null };
  }

  if (requested === BRANCH_REV) {
    // The combined view simply isn't there when there's nothing to diff
    // against; falling back silently beats a scary notice.
    return hasBranchDiff
      ? { rev: BRANCH_REV, notice: null }
      : { rev: fallback, notice: null };
  }

  const match = commits.find(
    (c) => c.sha === requested || c.sha.startsWith(requested),
  );
  if (match) return { rev: match.sha, notice: null };

  return { rev: fallback, notice: requested };
}
