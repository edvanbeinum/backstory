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
  /**
   * A branch to review instead of whatever the worktree has checked out.
   * Stacked PRs mostly live as plain branches, and reviewing one needs no
   * checkout — so which branch you're reading is part of the address.
   */
  ref?: string | null;
  rev: string | null;
  /** Selected review thread id */
  comment: string | null;
  /** The workspace tab; absent when the URL doesn't ask for one */
  tab?: Tab;
  /** The inbox shows the setup checklist, as the Mac app's Set Up Backstory… asks */
  setup?: boolean;
}

export type Tab = "story" | "files" | "comments";
const TABS: readonly Tab[] = ["story", "files", "comments"];

/** Pure half of readUrlState, so it can be tested without a DOM. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const repo = params.get("repo")?.trim();
  const ref = params.get("ref")?.trim();
  const rev = params.get("rev")?.trim();
  const comment = params.get("comment")?.trim();
  const tab = TABS.find((t) => t === params.get("tab")?.trim());

  return {
    repo: repo ? repo : null,
    ...(ref && { ref }),
    rev: rev ? rev : null,
    comment: comment ? comment : null,
    ...(tab && { tab }),
    ...(params.get("setup") === "1" && { setup: true }),
  };
}

/**
 * The tab a URL opens on. Story unless the URL names another, so the diff is
 * never the first screen; a `?comment=` link from before tabs opens Comments.
 */
export function resolveTab(state: Pick<UrlState, "tab" | "comment">): Tab {
  return state.tab ?? (state.comment ? "comments" : "story");
}

export function buildUrl(state: Partial<UrlState>, pathname = "/"): string {
  const params = new URLSearchParams();
  if (state.repo) params.set("repo", state.repo);
  if (state.ref) params.set("ref", state.ref);
  // `working` is the default landing spot; leaving it out keeps the common
  // URL short, and a missing rev falls back to it anyway.
  if (state.rev && state.rev !== WORKING_REV) params.set("rev", state.rev);
  // Story is where every view lands, so it is left out unless a comment is
  // there too: a comment alone would reopen on Comments.
  if (state.tab && (state.tab !== "story" || state.comment))
    params.set("tab", state.tab);
  if (state.comment) params.set("comment", state.comment);
  if (state.setup) params.set("setup", "1");

  // URLSearchParams percent-encodes slashes, which turns every repo path into
  // an unreadable %2F soup. A slash is legal unencoded in a query string, and
  // parsing only ever splits on & and =, so putting them back is safe and
  // makes the URL something you can actually read. Everything else — &, =, #,
  // spaces — stays encoded.
  const query = params.toString().replace(/%2F/g, "/");
  return `${pathname}${query ? `?${query}` : ""}`;
}

/**
 * The query for a request about one view, with `ref` whenever the repo is
 * open on a branch it hasn't checked out. Without `ref` the server reads the
 * checkout's branch, so every view request is built here.
 */
export function viewParams({
  repo,
  ref,
  rev,
  ...extra
}: {
  repo: string;
  ref?: string | null;
  rev: string;
  [extra: string]: string | null | undefined;
}): URLSearchParams {
  const params = new URLSearchParams({ repo });
  if (ref) params.set("ref", ref);
  params.set("rev", rev);
  for (const [key, value] of Object.entries(extra))
    if (value != null) params.set(key, value);
  return params;
}

const EMPTY_STATE: UrlState = {
  repo: null,
  rev: null,
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
export function writeUrlState(state: UrlState, opts: { push?: boolean } = {}) {
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

/**
 * The comment to focus: the one a URL (or the previous session) asked for,
 * while the PR still has it. A thread can vanish — deleted, or the branch now
 * matches a different PR — and then nothing is focused.
 */
export function resolveComment(
  requested: string | null,
  threads: Array<{ id: string }>,
): string | null {
  return requested && threads.some((t) => t.id === requested)
    ? requested
    : null;
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
  /**
   * Shas chosen by hand this session — pasted into the commit picker rather
   * than picked from the offered list. Backstory can render any commit in the
   * repo, but it only *lists* the branch's recent ones, so without this a
   * pasted sha would be bounced back by the next background refresh a second
   * after you chose it. A rev from a URL still falls back, which is what
   * keeps a stale bookmark graceful.
   */
  pinned: string[] = [],
): RevResolution {
  // Open on uncommitted work while there is some, as that's what an agent
  // waiting on review has just written; otherwise on the whole branch.
  const fallback = hasWorkingChanges
    ? WORKING_REV
    : hasBranchDiff
      ? BRANCH_REV
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

  if (pinned.includes(requested)) return { rev: requested, notice: null };

  return { rev: fallback, notice: requested };
}
