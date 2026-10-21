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
export const GITHUB_LOGIN_API = "/api/github/login";
export const AI_API = "/api/ai";

/** What Claude Code does for Backstory, on the setup checklist and the Claude Code gate. */
export const DRAWS_WITH_CLAUDE_CODE =
  "Backstory draws each repo's map, data model and flows with Claude Code, through your own Claude Code login.";

/**
 * Backstory's OAuth App on GitHub, with Device Flow on. Safe to ship: the
 * device flow needs no client secret.
 */
export const GITHUB_CLIENT_ID = "Ov23liKf55SoAcIcJfeK";

export const STORAGE_KEY = "backstory.repoPath";

/**
 * Canonical repo roots the inbox scans. Separate from `backstory.recentRepos`,
 * which holds worktree paths and is capped — with twenty worktrees it would
 * fill with one repo and evict the other.
 */
export const INBOX_ROOTS_KEY = "backstory.inboxRepos";
