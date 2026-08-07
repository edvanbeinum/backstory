export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number on the old side, null for added lines */
  oldNo: number | null;
  /** 1-based line number on the new side, null for removed lines */
  newNo: number | null;
  content: string;
  /** Pre-highlighted HTML for `content`, filled in by lib/highlight.ts */
  html?: string;
  noNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Path to show in the UI — newPath when it exists, else oldPath */
  path: string;
  status: FileStatus;
  isBinary: boolean;
  /** True when the file is text but the diff was suppressed for size */
  truncated?: boolean;
  additions: number;
  deletions: number;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: DiffHunk[];
  lang: string | null;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 */
  date: string;
  /** github.com commit URL, null when there is no GitHub remote */
  url: string | null;
  /** Merges are diffed against their first parent, not shown empty */
  isMerge: boolean;
}

/**
 * How `<base>..HEAD` was resolved. Surfaced in the UI so the commit list is
 * never mysterious — "unpushed" means different things with and without an
 * upstream, and some branches have neither an upstream nor an origin ref.
 */
export type BaseReason =
  | "upstream"
  | "origin-branch"
  | "default-branch"
  | "local-default"
  | "root";

export interface BaseInfo {
  /** The ref or sha we diff against */
  ref: string;
  sha: string | null;
  reason: BaseReason;
  /** Human-readable explanation for the header */
  label: string;
  /**
   * Where the rail's divider actually sits: parent of the oldest unpushed
   * commit. Diverges from `sha` after a rebase, when the upstream's merge
   * base falls behind the commits that are genuinely unpushed.
   */
  boundarySha?: string | null;
}

export interface RepoInfo {
  /** Path the user typed */
  input: string;
  /** Worktree root as git reports it */
  root: string;
  branch: string | null;
  /** True when HEAD is detached */
  detached: boolean;
  remoteUrl: string | null;
  owner: string | null;
  name: string | null;
  defaultBranch: string | null;
}

export interface WorkingTreeInfo {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Paths of untracked files, needed to synthesise their diffs */
  untrackedPaths: string[];
  /**
   * Every path the working tree touches, tracked and untracked. Lets the
   * comment view decide whether uncommitted work answers a given comment
   * without asking the server a second time.
   */
  changedPaths: string[];
}

export interface ReviewComment {
  id: string;
  databaseId: number | null;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
  /** The diff context GitHub captured when the comment was written */
  diffHunk: string | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  /** Current line on the new side, null once the thread goes outdated */
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  /** "RIGHT" | "LEFT" */
  side: string | null;
  comments: ReviewComment[];
  /**
   * The commit you linked to this comment. Never inferred: differ used to
   * guess (the newest commit touching the file), but a guess always found
   * *something*, so no comment ever read as outstanding and the list
   * couldn't work as a checklist. Asserting the link is also the moment you
   * actually check the change against the comment.
   */
  linkedSha?: string | null;
  /**
   * Handled without a code change — the comment only wanted a reply. Counts
   * as addressed alongside a commit link.
   */
  acknowledged?: boolean;
  /**
   * A top-level review body rather than an inline thread. It has no file or
   * line, but it still needs addressing, so it belongs in the checklist.
   */
  isReviewSummary?: boolean;
  /** A saved reply the user was part-way through writing. */
  draft?: string | null;
  /**
   * True when `linkedSha` no longer exists on the branch and couldn't be
   * re-matched — a squash, an amend, or a conflict-resolved rebase changed
   * the diff, so the patch-id matches nothing. The link is kept (not
   * silently dropped) and the UI asks you to re-link.
   */
  linkedShaMissing?: boolean;
  /**
   * The link was re-matched to a rewritten commit by patch-id this load.
   * Shown once so a silent re-point is never invisible.
   */
  linkedShaHealed?: boolean;
}

export interface ReviewSummary {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  state: string;
  url: string;
  createdAt: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  author: string;
}

export interface GitHubData {
  pr: PullRequestInfo | null;
  threads: ReviewThread[];
  reviews: ReviewSummary[];
  /** Set when GitHub data could not be loaded; the app still shows diffs */
  unavailable: string | null;
}

/** Headline numbers for the combined branch-vs-default diff. */
export interface BranchDiffSummary {
  /** The commit the branch is diffed against (fork point or merge base) */
  baseSha: string;
  /** e.g. "vs main" — what the diff is against, for the UI */
  label: string;
  /** Commits on the branch ahead of the base */
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface SessionResponse {
  repo: RepoInfo;
  base: BaseInfo;
  commits: CommitSummary[];
  /** Already-pushed commits at and below the push boundary, newest first */
  history: CommitSummary[];
  working: WorkingTreeInfo;
  github: GitHubData;
  /** Null when there's nothing to diff (on the default branch tip, no base) */
  branchDiff: BranchDiffSummary | null;
}

export interface DiffResponse {
  rev: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Set when highlighting was skipped because the diff is very large */
  highlightSkipped?: boolean;
}

/** One file rendered with full context — the "view whole file" response. */
export interface FileViewResponse {
  rev: string;
  path: string;
  file: DiffFile;
  /** Total lines in the rendered file */
  lineCount: number;
  highlightSkipped?: boolean;
}

export interface ApiError {
  error: string;
  detail?: string;
  /** Distinguishes "you typed a bad path" from "git blew up" in the UI */
  kind?: "not-a-repo" | "missing-path" | "git" | "internal";
}
