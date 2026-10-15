import { ExecError, run } from "./exec";
import { homeDir } from "./store";
import type {
  GitHubData,
  PullRequestInfo,
  RepoInfo,
  ReviewComment,
  ReviewSummary,
  ReviewThread,
  ThreadResponse,
} from "./types";

/**
 * Reads pull requests, review threads and reviews from GitHub's GraphQL API,
 * with the token Connect GitHub saved in the Keychain when there is one, and
 * through `gh` otherwise.
 *
 * A failure degrades to "unavailable" with a readable reason instead of
 * throwing, because GitHub is a level up, not a requirement: the commits and
 * diffs still work without it.
 */

/**
 * Threads arrive from GitHub with nothing attached; the session route reads
 * the store and replaces this. Shared and frozen so a stray write can't leak
 * one thread's state onto another.
 */
export const NO_RESPONSE: ThreadResponse = Object.freeze({
  done: false,
  doneAt: null,
  reply: null,
  commits: [],
});

export function gh(cwd: string, args: string[]) {
  return run("gh", args, {
    cwd,
    timeout: 20_000,
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
  });
}

const KEYCHAIN_SERVICE = "dev.backstory.github";
const TOKEN_SHAPE = /^[A-Za-z0-9_]+$/;
const SECURITY_TIMEOUT_MS = 10_000;
/** `security`'s exit code for an item that isn't there */
const NOT_IN_KEYCHAIN = 44;

/**
 * Runs `security` by name, so a test's stand-in on PATH answers instead of
 * the real Keychain. The account is the store directory, so a test's temp
 * `BACKSTORY_HOME` can't reach the real token even when it does get the real
 * `security`.
 */
function security(args: string[], opts: { input?: string } = {}) {
  return run("security", args, {
    timeout: SECURITY_TIMEOUT_MS,
    input: opts.input,
    allowExitCodes: [NOT_IN_KEYCHAIN],
  });
}

/**
 * The token Connect GitHub saved, or null. Read on every call rather than
 * kept in env, so `claude`, `git` and `gh` children never inherit it. A read
 * that fails for any reason counts as no token, which falls back to `gh`.
 */
export async function githubToken(): Promise<string | null> {
  try {
    const { stdout, code } = await security([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      homeDir(),
      "-w",
    ]);
    const token = stdout.trim();
    return code === 0 && TOKEN_SHAPE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Sends the command on stdin to `security -i`, so the token never shows in
 * argv, where `ps` would show it. Every read, write and delete goes through
 * `security`, so the item's access list stays as `security` made it and the
 * Keychain never asks the user to allow access.
 */
export async function saveGitHubToken(token: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) {
    throw new Error("GitHub sent a token Backstory doesn't recognise.");
  }
  const account = `"${homeDir().replace(/["\\]/g, "\\$&")}"`;
  await security(["-i"], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${token}\n`,
  });
  // Read it back: `security -i` exits 0 even when a command inside it fails.
  if ((await githubToken()) !== token) {
    throw new Error("Couldn't save the token in the Keychain.");
  }
}

/** Deletes the saved token. With none saved, does nothing. */
export async function forgetGitHubToken(): Promise<void> {
  await security([
    "delete-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    homeDir(),
  ]);
}

/**
 * The token only goes to github.com. A dotless host is an ssh alias such as
 * `git@github-work:Owner/Repo`, assumed to be github.com; an Enterprise
 * server keeps using `gh`.
 */
function tokenCovers(host: string | null): boolean {
  return (
    host === "github.com" ||
    host === "ssh.github.com" ||
    (host !== null && host !== "" && !host.includes("."))
  );
}

/** GitHub refused the saved token: revoked (401), or missing the `repo` scope. */
class TokenRejected extends Error {}

/** GitHub answered the saved token's request with GraphQL errors. */
class TokenRequestError extends Error {}

/** The saved token's request never reached GitHub: no network, or a timeout. */
class GitHubOffline extends Error {}

/**
 * GitHub can't be reached with anything Backstory has: the saved token was
 * refused and `gh` is missing or logged out. The fix is Connect GitHub.
 */
export class GitHubConnectError extends Error {
  constructor() {
    super("Connect GitHub to see this pull request's review comments.");
    this.name = "GitHubConnectError";
  }
}

type Variables = Record<string, string | number>;

async function askWithToken<T>(
  token: string,
  query: string,
  variables: Variables,
): Promise<T> {
  const api = process.env.BACKSTORY_GITHUB_API ?? "https://api.github.com";
  let response: Response;
  try {
    response = await fetch(`${api}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new GitHubOffline(err instanceof Error ? err.message : String(err));
  }
  if (response.status === 401) throw new TokenRejected("revoked");
  const scopes = response.headers.get("x-oauth-scopes");
  if (
    scopes !== null &&
    !scopes.split(",").some((scope) => scope.trim() === "repo")
  ) {
    throw new TokenRejected("missing the repo scope");
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new TokenRequestError(body.errors.map((e) => e.message).join("; "));
  }
  return body.data as T;
}

async function askWithGh<T>(
  cwd: string,
  query: string,
  variables: Variables,
): Promise<T> {
  // `-f` keeps a string a string: `-F` would turn a branch called `123` into
  // a number and read a file for one starting with `@`.
  const { stdout } = await gh(cwd, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => [
      typeof value === "number" ? "-F" : "-f",
      `${key}=${value}`,
    ]),
  ]);
  const parsed = JSON.parse(stdout) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  }
  return parsed.data as T;
}

function ghNotReady(err: unknown): boolean {
  if (!(err instanceof ExecError)) return false;
  if (err.code === 127) return true;
  const msg = err.message.toLowerCase();
  return msg.includes("auth") || msg.includes("login");
}

/**
 * Every GitHub read: a GraphQL query, with the saved token when there is one
 * and the remote is github.com, through `gh` otherwise. A refused token is
 * forgotten and the call tried again through `gh`.
 */
export async function githubGraphql<T>(
  cwd: string,
  query: string,
  variables: Variables,
  opts: { host: string | null },
): Promise<T> {
  let rejected = false;
  if (tokenCovers(opts.host)) {
    const token = await githubToken();
    if (token) {
      try {
        return await askWithToken<T>(token, query, variables);
      } catch (err) {
        if (!(err instanceof TokenRejected)) throw err;
        rejected = true;
        await forgetGitHubToken().catch(() => {});
      }
    }
  }
  try {
    return await askWithGh<T>(cwd, query, variables);
  } catch (err) {
    if (rejected && ghNotReady(err)) throw new GitHubConnectError();
    throw err;
  }
}

/**
 * Whether the saved token still works, for the setup checklist: null with no
 * token, false once GitHub refuses it (and it's forgotten), and true when
 * GitHub can't be reached, so an offline Mac isn't asked to sign in again.
 */
export async function githubTokenWorks(): Promise<boolean | null> {
  const token = await githubToken();
  if (!token) return null;
  try {
    await askWithToken(token, "query { viewer { login } }", {});
    return true;
  } catch (err) {
    if (!(err instanceof TokenRejected)) return true;
    await forgetGitHubToken().catch(() => {});
    return false;
  }
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 50) {
        nodes {
          id
          body
          state
          url
          createdAt
          author { login avatarUrl }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          diffSide
          comments(first: 50) {
            nodes {
              id
              databaseId
              body
              createdAt
              url
              diffHunk
              author { login avatarUrl }
            }
          }
        }
      }
    }
  }
}`;

const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, CLOSED, MERGED], first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        baseRefName
        headRefName
        author { login }
        isCrossRepository
        headRepositoryOwner { login }
      }
    }
  }
}`;

interface GqlThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  diffSide: string | null;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number | null;
      body: string;
      createdAt: string;
      url: string;
      diffHunk: string | null;
      author: { login: string; avatarUrl: string | null } | null;
    }>;
  };
}

interface GqlReviewNode {
  id: string;
  body: string;
  state: string;
  url: string;
  createdAt: string;
  author: { login: string; avatarUrl: string | null } | null;
}

/**
 * Short-TTL cache over loadGitHubData. The filesystem watcher triggers a
 * session refetch on every local change — a commit, a save, a stage — and
 * none of those change anything on GitHub's side. Without this, an active
 * work session would poll the GitHub API once per keystroke-burst. A push IS
 * a remote change, so the watcher passes `fresh` for those (and the manual
 * refresh button does too).
 *
 * Kept on globalThis because Next may load this module once per route
 * bundle, and the login route's clearGitHubCache has to empty the session
 * route's copy.
 */
const GH_CACHE_TTL_MS = 30_000;
const shared = globalThis as {
  __backstoryGhCache?: Map<string, { at: number; data: GitHubData }>;
};
const ghCache = (shared.__backstoryGhCache ??= new Map());

/** Empties the session cache, so connecting or disconnecting shows at once. */
export function clearGitHubCache() {
  ghCache.clear();
}

export async function loadGitHubDataCached(
  repo: RepoInfo,
  opts: { fresh?: boolean } = {},
): Promise<GitHubData> {
  const key = `${repo.root}\u0000${repo.branch ?? ""}`;
  const hit = ghCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < GH_CACHE_TTL_MS) {
    return hit.data;
  }
  const data = await loadGitHubData(repo);
  ghCache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Everything GitHub-side, in one call. Every failure path degrades to
 * `unavailable` with a readable reason rather than throwing — the commits and
 * diffs are still worth showing when GitHub is unreachable or `gh` is missing.
 */
export async function loadGitHubData(repo: RepoInfo): Promise<GitHubData> {
  const empty: GitHubData = {
    pr: null,
    threads: [],
    reviews: [],
    unavailable: null,
    connect: false,
  };

  if (!repo.owner || !repo.name) {
    return {
      ...empty,
      unavailable: "No GitHub remote — showing local commits only.",
    };
  }
  if (!repo.branch) {
    return {
      ...empty,
      unavailable: "HEAD is detached, so there's no branch to match a PR to.",
    };
  }

  let pr: PullRequestInfo | null;
  try {
    pr = await findPullRequest(repo, repo.branch);
  } catch (err) {
    const { message, connect } = describeGhError(err);
    return { ...empty, unavailable: message, connect };
  }

  if (!pr) {
    return {
      ...empty,
      unavailable: `No pull request found for ${repo.branch}.`,
    };
  }

  try {
    const { threads, reviews } = await loadThreads(repo, pr.number);
    return { pr, threads, reviews, unavailable: null, connect: false };
  } catch (err) {
    const { message, connect } = describeGhError(err);
    return { ...empty, pr, unavailable: message, connect };
  }
}

async function findPullRequest(
  repo: RepoInfo,
  branch: string,
): Promise<PullRequestInfo | null> {
  const data = await githubGraphql<{
    repository?: {
      pullRequests?: {
        nodes: Array<{
          number: number;
          title: string;
          url: string;
          state: string;
          isDraft: boolean;
          baseRefName: string;
          headRefName: string;
          author: { login: string } | null;
          isCrossRepository?: boolean;
          headRepositoryOwner?: { login: string } | null;
        }>;
      };
    };
  }>(
    repo.root,
    PULL_REQUESTS_QUERY,
    { owner: repo.owner ?? "", name: repo.name ?? "", branch },
    { host: repo.host },
  );

  const chosen = pickPullRequest(
    data?.repository?.pullRequests?.nodes ?? [],
    repo.owner,
  );
  if (!chosen) return null;

  return {
    number: chosen.number,
    title: chosen.title,
    url: chosen.url,
    state: chosen.state,
    isDraft: chosen.isDraft,
    baseRefName: chosen.baseRefName,
    headRefName: chosen.headRefName,
    author: chosen.author?.login ?? "",
  };
}

async function loadThreads(repo: RepoInfo, number: number) {
  const data = await githubGraphql<{
    repository?: {
      pullRequest?: {
        reviews?: { nodes: GqlReviewNode[] };
        reviewThreads?: { nodes: GqlThreadNode[] };
      };
    };
  }>(
    repo.root,
    THREADS_QUERY,
    { owner: repo.owner ?? "", name: repo.name ?? "", number },
    { host: repo.host },
  );

  const pull = data?.repository?.pullRequest;

  const threads: ReviewThread[] = (pull?.reviewThreads?.nodes ?? []).map(
    (node) => ({
      id: node.id,
      isResolved: node.isResolved,
      isOutdated: node.isOutdated,
      path: node.path,
      line: node.line,
      originalLine: node.originalLine,
      startLine: node.startLine,
      side: node.diffSide,
      // Filled in by the session route, which is where the store is read.
      response: NO_RESPONSE,
      comments: node.comments.nodes.map((c): ReviewComment => ({
        id: c.id,
        databaseId: c.databaseId,
        author: c.author?.login ?? "ghost",
        avatarUrl: c.author?.avatarUrl ?? null,
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
        diffHunk: c.diffHunk,
      })),
    }),
  );

  // Review summaries with an empty body are just the "approved"/"commented"
  // envelope around inline comments; only the ones with prose are interesting.
  const reviews: ReviewSummary[] = (pull?.reviews?.nodes ?? [])
    .filter((r) => r.body.trim().length > 0)
    .map((r) => ({
      id: r.id,
      author: r.author?.login ?? "ghost",
      avatarUrl: r.author?.avatarUrl ?? null,
      body: r.body,
      state: r.state,
      url: r.url,
      createdAt: r.createdAt,
    }));

  return { threads, reviews };
}

const NOT_REACHABLE =
  "This repository isn't reachable on GitHub with your current login.";

/**
 * A readable reason for a failed GitHub read. `connect` is set when the fix
 * is Connect GitHub, so the page can link to the setup checklist.
 */
export function describeGhError(err: unknown): {
  message: string;
  connect: boolean;
} {
  if (err instanceof GitHubConnectError || ghNotReady(err)) {
    return { message: new GitHubConnectError().message, connect: true };
  }
  const failed = (message: string) => ({ message, connect: false });
  if (err instanceof TokenRequestError) {
    if (err.message.toLowerCase().includes("could not resolve to a repository"))
      return failed(
        `${NOT_REACHABLE} If it belongs to an organisation, the organisation may need to approve Backstory.`,
      );
    return failed(`GitHub lookup failed: ${err.message}`);
  }
  if (err instanceof GitHubOffline) {
    return failed("GitHub lookup failed: couldn't reach GitHub.");
  }
  if (err instanceof Error) {
    if (err.message.toLowerCase().includes("could not resolve to a repository"))
      return failed(NOT_REACHABLE);
    return failed(`GitHub lookup failed: ${err.message.split("\n")[0]}`);
  }
  return failed("GitHub lookup failed.");
}

/**
 * Which of several PRs on the same branch name is *yours*.
 *
 * Matching on head branch alone reaches into forks. On a public repo,
 * `headRefName: "trunk"` returns every contributor who pushed a branch called
 * trunk to their own fork — measured against cli/cli, five of them, all
 * `isCrossRepository`. Without this, opening a worktree sitting on `main` or
 * `master` would attach a stranger's pull request and present their review
 * comments as your checklist.
 *
 * Shared by the workspace and the inbox on purpose. If they picked
 * differently the home screen's counts would describe a different PR from the
 * one that opens when you click the row.
 */
export function pickPullRequest<
  T extends {
    number: number;
    state: string;
    isCrossRepository?: boolean;
    headRepositoryOwner?: { login: string } | null;
  },
>(candidates: T[], repoOwner: string | null): T | null {
  if (candidates.length === 0) return null;

  const sameRepo = candidates.filter((row) => {
    if (row.isCrossRepository === true) return false;
    if (!repoOwner || !row.headRepositoryOwner) return true;
    return row.headRepositoryOwner.login === repoOwner;
  });
  // Only fall back to a fork's PR when nothing local matches — better than
  // showing nothing when the field is missing from an older `gh`.
  const pool = sameRepo.length > 0 ? sameRepo : candidates;

  // An open PR is what you're about to push to; fall back to the newest.
  return (
    pool.find((row) => row.state === "OPEN") ??
    [...pool].sort((a, b) => b.number - a.number)[0]
  );
}
