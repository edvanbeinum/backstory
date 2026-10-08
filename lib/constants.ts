/** The pseudo-rev used for uncommitted work, on both the client and the API. */
export const WORKING_REV = "working";

/**
 * The pseudo-rev for the combined branch diff — everything the PR will
 * contain, diffed in one piece against the default branch. GitHub's "Files
 * changed" tab, before the push.
 */
export const BRANCH_REV = "branch";

export const DIFF_API = "/api/diff";
export const NOTES_API = "/api/notes";
export const REVIEW_API = "/api/review";
export const OUTBOX_API = "/api/outbox";

export const STORAGE_KEY = "backstory.repoPath";

/**
 * Canonical repo roots the inbox scans. Separate from `backstory.recentRepos`,
 * which holds worktree paths and is capped — with twenty worktrees it would
 * fill with one repo and evict the other.
 */
export const INBOX_ROOTS_KEY = "backstory.inboxRepos";
