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
/** Which list the rail is showing. Comments is the default. */
export type RailMode = "comments" | "commits";

export interface UrlState {
  repo: string | null;
  rev: string | null;
  /** Rail mode; null means the default (comments) */
  mode: RailMode | null;
  /** Selected review thread id */
  comment: string | null;
}

/** Pure half of readUrlState, so it can be tested without a DOM. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const repo = params.get("repo")?.trim();
  const rev = params.get("rev")?.trim();
  const mode = params.get("mode")?.trim();
  const comment = params.get("comment")?.trim();

  return {
    repo: repo ? repo : null,
    rev: rev ? rev : null,
    // Anything other than the two known modes is treated as absent rather
    // than trusted into state.
    mode: mode === "comments" || mode === "commits" ? mode : null,
    comment: comment ? comment : null,
  };
}

export function buildUrl(state: Partial<UrlState>, pathname = "/"): string {
  const params = new URLSearchParams();
  if (state.repo) params.set("repo", state.repo);
  // Only the non-default mode is worth spelling out.
  if (state.mode === "commits") params.set("mode", "commits");

  // Each param is emitted independently of mode, so a link carries where you
  // were in *both* lists — toggling back to Commits returns you to the commit
  // you were reading rather than resetting it.
  //
  // `working` is the default landing spot; leaving it out keeps the common
  // URL short, and a missing rev falls back to it anyway.
  if (state.rev && state.rev !== WORKING_REV) params.set("rev", state.rev);
  if (state.comment) params.set("comment", state.comment);

  // URLSearchParams percent-encodes slashes, which turns every repo path into
  // an unreadable %2F soup. A slash is legal unencoded in a query string, and
  // parsing only ever splits on & and =, so putting them back is safe and
  // makes the URL something you can actually read. Everything else — &, =, #,
  // spaces — stays encoded.
  const query = params.toString().replace(/%2F/g, "/");
  return `${pathname}${query ? `?${query}` : ""}`;
}

const EMPTY_STATE: UrlState = {
  repo: null,
  rev: null,
  mode: null,
  comment: null,
};

export function readUrlState(): UrlState {
  if (typeof window === "undefined") return EMPTY_STATE;
  return parseUrlState(window.location.search);
}

/**
 * Replace rather than push. Moving between commits with j/k would otherwise
 * bury the previous page under dozens of history entries, and the URL only
 * needs to be *current*, not a trail.
 */
export function writeUrlState(
  state: UrlState,
  opts: { push?: boolean } = {},
) {
  if (typeof window === "undefined") return;

  const next = buildUrl(state, window.location.pathname);
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) {
    // `push` only for inbox↔workspace, which are real navigations: without a
    // history entry the Back button skips straight past the inbox. Everything
    // else replaces, or j/k would bury the history stack.
    if (opts.push) window.history.pushState(null, "", next);
    else window.history.replaceState(null, "", next);
  }
}

export interface CommentResolution {
  commentId: string | null;
  /** The requested id, when it's no longer in the PR */
  notice: string | null;
}

/**
 * Decide which comment to show, given what a URL (or the previous session)
 * asked for and what threads the PR actually has.
 *
 * A thread can vanish — deleted, or the branch now matches a different PR —
 * so a stale `?comment=` falls back to the first open thread and says so,
 * the same way resolveRev handles a rev that has gone. Falling back to *open*
 * rather than merely first matches the workflow: the list is a to-do.
 */
export function resolveComment(
  requested: string | null,
  threads: Array<{ id: string; isResolved: boolean }>,
): CommentResolution {
  const fallback =
    threads.find((t) => !t.isResolved)?.id ?? threads[0]?.id ?? null;

  if (!requested) return { commentId: fallback, notice: null };
  if (threads.some((t) => t.id === requested)) {
    return { commentId: requested, notice: null };
  }
  return { commentId: fallback, notice: requested };
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
