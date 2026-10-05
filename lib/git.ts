import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { ExecError, git, gitLine, gitTry, run } from "./exec";
import type {
  BaseInfo,
  BranchDiffSummary,
  CommitSummary,
  RepoInfo,
  WorkingTreeInfo,
} from "./types";

/**
 * Reads repos, commits, patches and the working tree, all through `git()`,
 * and never writes to the repo.
 *
 * The base of "All changes" comes from the PR's `baseRefName` when there is
 * a PR, so a stacked PR doesn't also show its parent branches. A commit
 * linked to a thread survives a rebase because the link is kept by patch-id,
 * not sha.
 */

export class RepoError extends Error {
  constructor(
    message: string,
    readonly kind: "missing-path" | "not-a-repo" | "git",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

/** Expand `~`, resolve relative segments, and normalise. */
export function expandPath(input: string): string {
  let p = input.trim();
  if (!p) return p;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
  return path.resolve(p);
}

// Common flags for every patch we parse. --no-ext-diff and --no-textconv keep
// a user's difftool config from replacing the patch body; -M finds renames so
// a moved file reads as a rename rather than a delete plus an add.
const PATCH_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "-M",
  "--find-copies",
];

export async function resolveRepo(
  input: string,
  ref?: string | null,
): Promise<RepoInfo> {
  const abs = expandPath(input);
  if (!abs) throw new RepoError("No repository path given", "missing-path");

  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      throw new RepoError(`Not a directory: ${abs}`, "missing-path");
    }
  } catch (err) {
    if (err instanceof RepoError) throw err;
    throw new RepoError(`Path does not exist: ${abs}`, "missing-path");
  }

  // --show-toplevel resolves worktrees transparently: a linked worktree has
  // `.git` as a file, and git still reports the right root.
  const root = await gitLine(abs, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new RepoError(`Not a git repository: ${abs}`, "not-a-repo");
  }

  const [branchRaw, remoteUrl] = await Promise.all([
    gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitLine(root, ["remote", "get-url", "origin"]),
  ]);

  const detached = branchRaw === "HEAD" || branchRaw === null;
  const checkedOut = detached ? null : branchRaw;
  const { owner, name } = parseRemote(remoteUrl);
  const defaultBranch = await resolveDefaultBranch(root);

  // A branch you asked for that isn't the one checked out here. Nothing about
  // reviewing a pushed branch needs it checked out — git reads any ref from
  // any worktree of the repo — and a stacked workflow leaves most of the
  // stack as plain branches, so insisting on a checkout would hide them.
  const reviewing = ref && ref !== checkedOut ? ref : null;

  return {
    input,
    root,
    branch: reviewing ?? checkedOut,
    checkedOut,
    ref: reviewing,
    // What the commit walks start from. HEAD when you're reviewing the
    // checkout, the branch itself when you're reviewing anything else.
    tip: reviewing ?? "HEAD",
    detached: detached && !reviewing,
    remoteUrl,
    owner,
    name,
    defaultBranch,
  };
}

/** Pull `owner/repo` out of any of git's remote URL spellings. */
export function parseRemote(url: string | null): {
  owner: string | null;
  name: string | null;
} {
  if (!url) return { owner: null, name: null };

  const cleaned = url.trim().replace(/\.git$/, "");

  // scp-style: git@github.com:Owner/Repo
  const scp = cleaned.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) {
    const parts = scp[2].split("/").filter(Boolean);
    if (parts.length >= 2)
      return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
  }

  // URL-style: https://github.com/Owner/Repo, ssh://git@github.com/Owner/Repo
  try {
    const parsed = new URL(cleaned);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2)
      return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
  } catch {
    // not a URL
  }

  return { owner: null, name: null };
}

/**
 * Find the repo's default branch without touching the network.
 * `git remote show origin` would be authoritative but makes a network call,
 * which is not acceptable inside a request.
 */
async function resolveDefaultBranch(root: string): Promise<string | null> {
  const symref = await gitLine(root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (symref) return symref.replace(/^origin\//, "");

  const init = await gitLine(root, ["config", "--get", "init.defaultBranch"]);
  const candidates = [init, "main", "master", "trunk"].filter(
    (c): c is string => Boolean(c),
  );

  for (const candidate of candidates) {
    const found = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${candidate}`,
    ]);
    if (found) return candidate;
  }
  for (const candidate of candidates) {
    const found = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${candidate}`,
    ]);
    if (found) return candidate;
  }
  return null;
}

/**
 * Work out what "not yet pushed" means for this branch.
 *
 * A branch with an upstream is easy. Plenty of branches don't have one —
 * worktrees made with `git worktree add -b` typically don't, and neither does
 * a branch you've never pushed — so fall back through progressively weaker
 * signals and tell the user which one was used.
 */
export async function resolveBase(repo: RepoInfo): Promise<BaseInfo> {
  const { root, branch, defaultBranch } = repo;

  const upstream = await gitLine(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${repo.tip}@{upstream}`,
  ]);
  if (upstream) {
    return finishBase(root, upstream, "upstream", `ahead of ${upstream}`);
  }

  if (branch) {
    const originBranch = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (originBranch) {
      const ref = `origin/${branch}`;
      return finishBase(root, ref, "origin-branch", `ahead of ${ref}`);
    }
  }

  if (defaultBranch) {
    const remoteDefault = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${defaultBranch}`,
    ]);
    if (remoteDefault) {
      const ref = `origin/${defaultBranch}`;
      return finishBase(
        root,
        ref,
        "default-branch",
        `branch never pushed — showing everything since ${ref}`,
      );
    }

    if (defaultBranch !== branch) {
      const localDefault = await gitLine(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${defaultBranch}`,
      ]);
      if (localDefault) {
        return finishBase(
          root,
          defaultBranch,
          "local-default",
          `no remote — showing everything since ${defaultBranch}`,
        );
      }
    }
  }

  return {
    ref: "",
    sha: null,
    reason: "root",
    label: "no base branch found — showing recent commits",
  };
}

async function finishBase(
  root: string,
  ref: string,
  reason: BaseInfo["reason"],
  label: string,
): Promise<BaseInfo> {
  // The merge base, not the ref tip: if the base branch has moved on, we want
  // the diff to show *our* changes, not everyone else's in reverse.
  const sha =
    (await gitLine(root, ["merge-base", ref, "HEAD"])) ??
    (await gitLine(root, ["rev-parse", ref]));
  return { ref, sha, reason, label };
}

// NUL between fields, ASCII record separator between commits — a subject or
// body can then contain anything at all, newlines included.
const FIELD_SEP = "\u0000";
const RECORD_SEP = "\u001e";
const LOG_FORMAT = ["%H", "%h", "%an", "%ae", "%aI", "%P", "%s", "%b"].join(
  "%x00",
);

/**
 * The commits shown as "not yet pushed": commits reachable from HEAD but not
 * from ANY remote ref (`HEAD --not --remotes`), not merely absent from the
 * branch's own upstream.
 *
 * The distinction matters after a rebase, and for stacked branches: rebasing
 * onto newer work makes `@{upstream}..HEAD` include every commit of the new
 * base that the stale upstream ref has never seen — commits that are already
 * pushed on *their* branches' remotes. Only when the repo has no remote refs
 * at all does the old range fallback apply.
 */
/** Does this repo know about any remote branch at all? */
export async function hasRemoteRefs(root: string): Promise<boolean> {
  return Boolean(
    await gitLine(root, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "refs/remotes",
    ]),
  );
}

export async function getCommits(
  repo: RepoInfo,
  base: BaseInfo,
  limit = 200,
): Promise<CommitSummary[]> {
  const remote = await hasRemoteRefs(repo.root);
  // Reviewing a branch that isn't checked out is almost always a pushed
  // stack entry, where "not on any remote" is empty and useless. Its own
  // commits — the ones its PR is about — are what to show.
  if (repo.ref) {
    const range = base.ref ? `${base.ref}..${repo.ref}` : repo.ref;
    return logRange(repo, [range], limit);
  }

  if (remote) {
    return logRange(repo, ["HEAD", "--not", "--remotes"], limit);
  }

  const range = base.ref ? `${base.ref}..HEAD` : "HEAD";
  return logRange(repo, [range], limit);
}

/** The commits in an arbitrary range, newest first. */
export async function getCommitRange(
  repo: RepoInfo,
  range: string,
  limit = 200,
): Promise<CommitSummary[]> {
  return logRange(repo, [range], limit);
}

/**
 * Where the push boundary sits: the parent of the oldest unpushed commit.
 * Usually this equals the base merge-base, but after a rebase the two
 * diverge — the boundary hugs the unpushed commits, keeping the timeline
 * contiguous, while base.sha may point at a stale upstream's merge base.
 */
export async function getBoundarySha(
  root: string,
  commits: CommitSummary[],
  base: BaseInfo,
  tip = "HEAD",
): Promise<string | null> {
  const oldest = commits[commits.length - 1];
  if (!oldest) {
    // Nothing unpushed — the boundary is HEAD itself.
    return (
      (await gitLine(root, ["rev-parse", "--verify", "--quiet", tip])) ??
      base.sha
    );
  }
  // A root commit has no parent; fall back to the merge base (may be null).
  return (
    (await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${oldest.sha}^`,
    ])) ?? base.sha
  );
}

/**
 * The already-pushed commits below the push boundary. Gives the change
 * picker its context: the unpushed work sits on top of this history rather
 * than floating alone.
 *
 * Scoped to the current branch: on a feature branch this stops at the fork
 * point instead of walking on into the default branch's history — the change
 * picker is a timeline of *this branch*, not of main. On the default branch itself
 * (or when there's no default to compare against) main's history IS the
 * branch's history, so the walk from the merge base stands.
 */
export async function getHistory(
  repo: RepoInfo,
  base: BaseInfo,
  limit = 30,
): Promise<CommitSummary[]> {
  // The walk starts at the boundary — the parent of the oldest unpushed
  // commit — so the timeline is contiguous even when a rebase has moved the
  // branch off its stale upstream's merge base.
  const start = base.boundarySha ?? base.sha;

  // No start means no boundary: everything is already in the "unpushed" list
  // (or there's no remote to be pushed to), so there's no history to show.
  if (!start) return [];

  const { root, branch, defaultBranch } = repo;
  if (!defaultBranch || branch === defaultBranch) {
    return logRange(repo, [start], limit);
  }

  // Find where this branch forked from the default branch.
  let fork: string | null = null;
  for (const ref of [
    `refs/remotes/origin/${defaultBranch}`,
    `refs/heads/${defaultBranch}`,
  ]) {
    const exists = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (exists) {
      fork = await gitLine(root, ["merge-base", ref, start]);
      break;
    }
  }

  // No fork point to be found — fall back to the plain walk.
  if (!fork) return logRange(repo, [start], limit);

  // The boundary sits exactly at the fork, so this branch has nothing of its
  // own — it's level with the default branch, which is what a worktree looks
  // like once its PR has merged. Walk plain history rather than returning
  // nothing: those commits are exactly the ones that answered the review, and
  // with an empty list there is no commit anywhere in the UI to link a
  // comment to.
  if (fork === start) return logRange(repo, [start], limit);

  return logRange(repo, [`${fork}..${start}`], limit);
}

async function logRange(
  repo: RepoInfo,
  rangeArgs: string[],
  limit: number,
): Promise<CommitSummary[]> {
  const out = await gitTry(repo.root, [
    "log",
    `--format=${LOG_FORMAT}%x1e`,
    `--max-count=${limit}`,
    ...rangeArgs,
  ]);
  if (!out) return [];

  const commits: CommitSummary[] = [];
  for (const record of out.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, "");
    if (!trimmed.trim()) continue;

    const fields = trimmed.split(FIELD_SEP);
    const [sha, shortSha, authorName, authorEmail, date, parents, subject] =
      fields;
    const body = fields[7];
    if (!sha) continue;

    commits.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      subject: subject ?? "",
      body: (body ?? "").trim(),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      url: commitUrl(repo, sha),
      isMerge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }

  return commits;
}

/**
 * What the combined branch diff is measured against: the fork point from the
 * default branch on a feature branch, or the push boundary itself when on
 * the default branch (there "vs main" means "vs origin/main"). Null when
 * there's nothing meaningful to diff against.
 */
/** Fork point from `branchName`, if a local or remote ref for it exists. */
async function forkPointFrom(
  root: string,
  branchName: string,
  tip = "HEAD",
): Promise<string | null> {
  for (const ref of [
    `refs/remotes/origin/${branchName}`,
    `refs/heads/${branchName}`,
  ]) {
    const exists = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (exists) return gitLine(root, ["merge-base", ref, tip]);
  }
  return null;
}

export async function getBranchDiffBase(
  repo: RepoInfo,
  base: BaseInfo,
  /**
   * The PR's own base branch (`baseRefName`), when there is a PR. This is
   * authoritative and beats the default branch: a stacked PR targets its
   * parent branch, so diffing against the default branch would show this
   * branch PLUS the whole parent stack — the PR itself shows far less.
   */
  prBaseRef?: string | null,
): Promise<{ baseSha: string; label: string } | null> {
  const { root, branch, defaultBranch } = repo;

  if (prBaseRef && prBaseRef !== branch) {
    const fork = await forkPointFrom(root, prBaseRef, repo.tip);
    if (fork) return { baseSha: fork, label: `vs ${prBaseRef}` };
    // The base branch isn't checked out locally — fall through rather than
    // silently diffing against something else.
  }

  if (defaultBranch && branch && branch !== defaultBranch) {
    const fork = await forkPointFrom(root, defaultBranch, repo.tip);
    if (fork) return { baseSha: fork, label: `vs ${defaultBranch}` };
  }

  if (base.sha) return { baseSha: base.sha, label: `vs ${base.ref}` };
  return null;
}

/** Headline numbers for the branch diff, cheap enough for every session. */
export async function getBranchDiffSummary(
  repo: RepoInfo,
  base: BaseInfo,
  prBaseRef?: string | null,
): Promise<BranchDiffSummary | null> {
  const info = await getBranchDiffBase(repo, base, prBaseRef);
  if (!info) return null;

  const count = await gitLine(repo.root, [
    "rev-list",
    "--count",
    `${info.baseSha}..${repo.tip}`,
  ]);
  const commits = Number(count ?? "0");
  if (commits === 0) return null;

  const stat =
    (await gitLine(repo.root, [
      "diff",
      "--shortstat",
      ...PATCH_FLAGS,
      info.baseSha,
      repo.tip,
    ])) ?? "";
  // " 12 files changed, 540 insertions(+), 210 deletions(-)" — any of the
  // three clauses can be absent.
  const filesChanged = Number(stat.match(/(\d+) files? changed/)?.[1] ?? "0");
  const additions = Number(stat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? "0");
  const deletions = Number(stat.match(/(\d+) deletions?\(-\)/)?.[1] ?? "0");

  return { ...info, commits, filesChanged, additions, deletions };
}

/** The patch between two commits — used for the combined branch diff. */
export async function getRangePatch(
  root: string,
  from: string,
  to: string,
  opts: PatchOptions = {},
): Promise<string> {
  const out = await gitTry(root, [
    "diff",
    ...PATCH_FLAGS,
    ...contextArgs(opts),
    from,
    to,
    ...pathspecArgs(opts),
  ]);
  return out ?? "";
}

export function commitUrl(repo: RepoInfo, sha: string): string | null {
  if (!repo.owner || !repo.name) return null;
  return `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`;
}

/**
 * The URL you actually want in a review reply: the commit *as viewed inside
 * the PR* — github.com/<owner>/<repo>/pull/<n>/commits/<sha> — rather than
 * the bare commit page.
 */
export function prCommitUrl(
  repo: RepoInfo,
  prNumber: number,
  sha: string,
): string | null {
  if (!repo.owner || !repo.name) return null;
  return `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}/commits/${sha}`;
}

export async function getWorkingTree(repo: RepoInfo): Promise<WorkingTreeInfo> {
  const out = await gitTry(repo.root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);

  const info: WorkingTreeInfo = {
    hasChanges: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    untrackedPaths: [],
    changedPaths: [],
  };
  if (!out) return info;

  const entries = out.split(FIELD_SEP).filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 3) continue;

    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);

    if (x === "?" && y === "?") {
      info.untracked++;
      info.untrackedPaths.push(filePath);
      info.changedPaths.push(filePath);
      continue;
    }

    info.changedPaths.push(filePath);

    // Renames and copies carry a second NUL-separated path: the entry's own
    // path is the destination and the next field is the source. Both count
    // as touched, so a comment on either name matches.
    if (x === "R" || x === "C") {
      const source = entries[++i];
      if (source) info.changedPaths.push(source);
    }

    if (x !== " " && x !== "?") info.staged++;
    if (y !== " " && y !== "?") info.unstaged++;
  }

  info.hasChanges = info.staged > 0 || info.unstaged > 0 || info.untracked > 0;
  return info;
}

/** Resolve a user-supplied rev to a full sha, or null if it doesn't exist. */
export async function resolveRev(
  root: string,
  rev: string,
): Promise<string | null> {
  return gitLine(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

export async function isMergeCommit(
  root: string,
  sha: string,
): Promise<boolean> {
  const out = await gitLine(root, ["rev-list", "--parents", "-n", "1", sha]);
  if (!out) return false;
  return out.trim().split(/\s+/).length > 2;
}

export interface PatchOptions {
  /**
   * Lines of context around each change. The default of 3 is git's own.
   * FULL_CONTEXT turns the patch into the entire file as a single hunk, which
   * is how "view whole file" is implemented — same patch format, so the
   * parser, highlighter and thread anchoring all work unchanged.
   */
  context?: number;
  /**
   * Limit the patch to these paths. A rename must pass *both* names: with
   * only the new one in the pathspec, git can't see the old blob and reports
   * the file as freshly added rather than renamed.
   */
  pathspec?: string | string[];
}

/** Big enough to swallow any file, small enough that git won't choke on it. */
export const FULL_CONTEXT = 1_000_000;

function contextArgs(opts: PatchOptions): string[] {
  return opts.context === undefined ? [] : [`-U${opts.context}`];
}

function pathspecArgs(opts: PatchOptions): string[] {
  if (!opts.pathspec) return [];
  const paths = (
    Array.isArray(opts.pathspec) ? opts.pathspec : [opts.pathspec]
  ).filter(Boolean);
  return paths.length > 0 ? ["--", ...paths] : [];
}

/**
 * Is `sha` reachable from HEAD?
 *
 * Not the same as "does this object exist": after a rebase the pre-rebase
 * commits are still in the object database, reachable via the reflog, so an
 * existence check happily validates a commit that is no longer on the
 * branch. Containment is what "this pin still points at real work" means.
 */
export async function isOnBranch(
  root: string,
  sha: string,
  tip = "HEAD",
): Promise<boolean> {
  const { code } = await run("git", ["merge-base", "--is-ancestor", sha, tip], {
    cwd: root,
    allowExitCodes: [1, 128],
    timeout: 10_000,
  }).catch(() => ({ code: 1 }));
  return code === 0;
}

/**
 * A commit's patch-id: a hash of its diff, ignoring parent and metadata.
 * Rebasing rewrites shas but preserves patch-ids, which is what lets a pin
 * survive a restack. Null for empty commits, merges, or if git declines.
 */
export async function getPatchId(
  root: string,
  sha: string,
): Promise<string | null> {
  const { stdout } = await run(
    "sh",
    [
      "-c",
      // patch-id reads a patch on stdin; --stable keeps the hash independent
      // of hunk ordering, which is what makes it comparable across rebases.
      'git diff-tree -p --no-color --no-ext-diff "$1" | git patch-id --stable',
      "sh",
      sha,
    ],
    { cwd: root, timeout: 15_000 },
  ).catch(() => ({ stdout: "" }));

  const id = stdout.trim().split(/\s+/)[0];
  return id && /^[0-9a-f]{40}$/.test(id) ? id : null;
}

/**
 * Patch-id → sha for every commit in `range`, in one pipeline rather than
 * one process per commit. Used to re-match pins after a rebase.
 *
 * A patch-id occurring more than once (revert-then-reapply, cherry-picked
 * duplicates) maps to null: an ambiguous match must not be guessed at.
 */
export async function getPatchIdMap(
  root: string,
  range: string,
): Promise<Map<string, string | null>> {
  const { stdout } = await run(
    "sh",
    [
      "-c",
      'git log --format="%H" "$1" | while read sha; do ' +
        'git diff-tree -p --no-color --no-ext-diff "$sha" | ' +
        "git patch-id --stable; done",
      "sh",
      range,
    ],
    { cwd: root, timeout: 60_000 },
  ).catch(() => ({ stdout: "" }));

  const map = new Map<string, string | null>();
  for (const line of stdout.split("\n")) {
    const [patchId, sha] = line.trim().split(/\s+/);
    if (!patchId || !sha) continue;
    // Second sighting of a patch-id makes it ambiguous, permanently.
    map.set(patchId, map.has(patchId) ? null : sha);
  }
  return map;
}

/** The patch for a single commit. Merges are diffed against their first parent. */
export async function getCommitPatch(
  root: string,
  sha: string,
  isMerge = false,
  opts: PatchOptions = {},
): Promise<string> {
  if (isMerge) {
    // `git show` prints nothing for a merge by default. First-parent is the
    // view that answers "what did landing this merge actually change?".
    const out = await gitTry(root, [
      "diff",
      ...PATCH_FLAGS,
      ...contextArgs(opts),
      `${sha}^1`,
      sha,
      ...pathspecArgs(opts),
    ]);
    return out ?? "";
  }

  try {
    const { stdout } = await git(root, [
      "show",
      ...PATCH_FLAGS,
      ...contextArgs(opts),
      "--format=",
      "--patch",
      sha,
      ...pathspecArgs(opts),
    ]);
    return stdout;
  } catch (err) {
    if (err instanceof ExecError) {
      throw new RepoError(`Could not read commit ${sha}`, "git", err.message);
    }
    throw err;
  }
}

const MAX_UNTRACKED = 100;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * The patch for uncommitted work: tracked changes against HEAD, plus a
 * synthesised patch per untracked file, so new files show up the way they will
 * once they're staged.
 */
export async function getWorkingPatch(
  root: string,
  untrackedPaths: string[],
  opts: PatchOptions = {},
): Promise<string> {
  const hasHead = await gitLine(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);

  const base = [
    "diff",
    ...PATCH_FLAGS,
    ...contextArgs(opts),
    hasHead ? "HEAD" : "--cached",
    ...pathspecArgs(opts),
  ];
  const tracked = await gitTry(root, base);

  const parts = [tracked ?? ""];

  // An untracked file the patch didn't cover — when scoped to particular
  // paths, only bother with the untracked ones among them.
  const wanted = opts.pathspec
    ? new Set(Array.isArray(opts.pathspec) ? opts.pathspec : [opts.pathspec])
    : null;
  const candidates = wanted
    ? untrackedPaths.filter((p) => wanted.has(p))
    : untrackedPaths.slice(0, MAX_UNTRACKED);

  for (const rel of candidates) {
    const patch = await untrackedPatch(root, rel, opts);
    if (patch) parts.push(patch);
  }

  return parts.filter(Boolean).join("\n");
}

async function untrackedPatch(
  root: string,
  rel: string,
  opts: PatchOptions = {},
): Promise<string | null> {
  try {
    const stat = await fs.stat(path.join(root, rel));
    if (!stat.isFile()) return null;
    if (stat.size > MAX_UNTRACKED_BYTES) {
      // Show it as a binary add so it's visible in the file list but never
      // rendered line by line.
      return `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
    }
  } catch {
    return null;
  }

  // --no-index exits 1 whenever it finds differences, which is always here.
  const { stdout } = await git(
    root,
    [
      "diff",
      ...PATCH_FLAGS,
      ...contextArgs(opts),
      "--no-index",
      "--",
      "/dev/null",
      rel,
    ],
    { allowExitCodes: [1] },
  );

  // --no-index writes its `diff --git` line with the raw paths (`/dev/null`
  // and the relative path), so normalise it to look like a tracked add.
  return stdout.replace(
    /^diff --git .*$/m,
    `diff --git a/${rel} b/${rel}\nnew file mode 100644`,
  );
}
