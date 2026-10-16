import { listWorktrees } from "./browse";
import { ExecError, git, gitLine, gitTry } from "./exec";
import { RepoError, resolveDefaultBranch } from "./git";
import { githubToken } from "./github";

/**
 * Fetches one branch from origin into a local branch of the same name, so a
 * teammate's pull request can be reviewed with `?ref=` and no terminal.
 *
 * This is the one module that writes to the repo. It updates remote-tracking
 * refs, as a plain `git fetch` does, and creates or moves a local branch only
 * when that loses nothing and changes no checkout: it never moves a branch a
 * worktree has checked out, and never one with commits origin doesn't have.
 */

export type FetchOutcome =
  "created" | "updated" | "unchanged" | "kept" | "checked-out";

export interface FetchResult {
  outcome: FetchOutcome;
  /** The local branch's tip afterwards. */
  sha: string;
  /** For `checked-out`: the worktree that has it. */
  worktree?: string;
}

type GitEnv = Record<string, string>;

const FETCH_TIMEOUT_MS = 60_000;
const GITHUB_HTTPS = "https://github.com/";

/**
 * Refuses a name git wouldn't accept as a branch before it reaches argv. The
 * name comes from the URL, and git reads a leading `-` as an option.
 * `--branch` also expands `@{-1}` into another branch, so anything git
 * rewrites is refused too.
 */
async function checkBranchName(root: string, name: string): Promise<void> {
  const checked = name.startsWith("-")
    ? null
    : await gitLine(root, ["check-ref-format", "--branch", name]);
  if (checked !== name) {
    throw new RepoError(`\`${name}\` isn't a branch name.`, "git");
  }
}

/**
 * The environments to run the fetch in, in order. A github.com https remote
 * tries Connect GitHub's token first, then git's own credentials: an
 * organisation that hasn't approved Backstory hides its repos from the token
 * but not from the user's git. The token goes in through `GIT_CONFIG_*`
 * rather than `-c`, which would put it in argv, where `ps` shows it, and the
 * key is scoped to github.com so no other host is ever sent it.
 */
export function credentialAttempts(
  remoteUrl: string,
  token: string | null,
): GitEnv[] {
  if (!token || !isGitHubHttps(remoteUrl)) return [{}];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${GITHUB_HTTPS}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
    {},
  ];
}

function isGitHubHttps(remoteUrl: string): boolean {
  try {
    const url = new URL(remoteUrl);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

const refspec = (branch: string) =>
  `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

function missingOnOrigin(err: unknown, branch: string): boolean {
  return (
    err instanceof ExecError &&
    err.message
      .split("\n")
      .some((line) =>
        line.trim().endsWith(`couldn't find remote ref refs/heads/${branch}`),
      )
  );
}

/**
 * Fetches `branch` and `base` together, and `branch` alone when origin no
 * longer has `base`, trying each credential in turn. Throws git's error from
 * the last attempt, which names the real cause.
 */
async function fetchFromOrigin(
  root: string,
  remoteUrl: string,
  branch: string,
  base: string | null,
): Promise<void> {
  const token = isGitHubHttps(remoteUrl) ? await githubToken() : null;
  const attempt = (env: GitEnv, branches: string[]) =>
    git(root, ["fetch", "--no-tags", "origin", ...branches.map(refspec)], {
      env: { ...process.env, ...env },
      timeout: FETCH_TIMEOUT_MS,
    });

  let last: unknown = null;
  for (const env of credentialAttempts(remoteUrl, token)) {
    try {
      await attempt(env, base ? [branch, base] : [branch]);
      return;
    } catch (err) {
      last = err;
      if (!base || !missingOnOrigin(err, base)) continue;
    }
    try {
      await attempt(env, [branch]);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const sha = (root: string, ref: string) =>
  gitLine(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

const isAncestor = async (root: string, a: string, b: string) =>
  (await gitTry(root, ["merge-base", "--is-ancestor", a, b])) !== null;

/**
 * Brings `branch` up to date with origin, and `base` with it, so "All
 * changes" doesn't show commits a newer base already has. Without a `base`,
 * the repo's default branch is fetched alongside.
 */
export async function fetchBranch(
  root: string,
  branch: string,
  base?: string | null,
): Promise<FetchResult> {
  await checkBranchName(root, branch);
  if (base) await checkBranchName(root, base);

  const remoteUrl = await gitLine(root, ["remote", "get-url", "origin"]);
  if (!remoteUrl) {
    throw new RepoError("This repo has no `origin` remote.", "git");
  }

  const alongside = base ?? (await resolveDefaultBranch(root));
  const before = await sha(root, `refs/remotes/origin/${branch}`);
  try {
    await fetchFromOrigin(
      root,
      remoteUrl,
      branch,
      alongside && alongside !== branch ? alongside : null,
    );
  } catch (err) {
    if (missingOnOrigin(err, branch)) {
      throw new RepoError(`\`${branch}\` isn't on origin.`, "git");
    }
    throw new RepoError(
      `Couldn't fetch \`${branch}\` from origin.`,
      "git",
      err instanceof Error ? err.message : String(err),
    );
  }

  const after = await sha(root, `refs/remotes/origin/${branch}`);
  if (!after) throw new RepoError(`\`${branch}\` isn't on origin.`, "git");

  const local = await sha(root, `refs/heads/${branch}`);
  if (!local) {
    await git(root, ["branch", "--track", branch, `origin/${branch}`]);
    return { outcome: "created", sha: after };
  }

  const holder = (await listWorktrees(root)).find((w) => w.branch === branch);
  if (holder) {
    return { outcome: "checked-out", sha: local, worktree: holder.path };
  }

  if (local === after) return { outcome: "unchanged", sha: local };

  // Checks the old origin tip as well as the new one, so a teammate's
  // force-push after a rebase still moves a branch with nothing of its own.
  const ownNothing =
    (await isAncestor(root, local, after)) ||
    (before !== null && (await isAncestor(root, local, before)));
  if (!ownNothing) return { outcome: "kept", sha: local };

  // The old value makes this a compare-and-swap, so a commit made on the
  // branch since it was read isn't overwritten.
  await git(root, ["update-ref", `refs/heads/${branch}`, after, local]);
  return { outcome: "updated", sha: after };
}
