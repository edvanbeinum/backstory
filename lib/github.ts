import { ExecError, run } from "./exec";
import type {
  GitHubData,
  PullRequestInfo,
  RepoInfo,
  ReviewComment,
  ReviewSummary,
  ReviewThread,
} from "./types";

function gh(cwd: string, args: string[]) {
  return run("gh", args, {
    cwd,
    timeout: 20_000,
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
  });
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
          author { login }
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
  author: { login: string } | null;
}

/**
 * Short-TTL cache over loadGitHubData. The filesystem watcher triggers a
 * session refetch on every local change — a commit, a save, a stage — and
 * none of those change anything on GitHub's side. Without this, an active
 * work session would poll the GitHub API once per keystroke-burst. A push IS
 * a remote change, so the watcher passes `fresh` for those (and the manual
 * refresh button does too).
 */
const GH_CACHE_TTL_MS = 30_000;
const ghCache = new Map<string, { at: number; data: GitHubData }>();

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
    return { ...empty, unavailable: describeGhError(err) };
  }

  if (!pr) {
    return {
      ...empty,
      unavailable: `No pull request found for ${repo.branch}.`,
    };
  }

  try {
    const { threads, reviews } = await loadThreads(repo, pr.number);
    return { pr, threads, reviews, unavailable: null };
  } catch (err) {
    return { ...empty, pr, unavailable: describeGhError(err) };
  }
}

async function findPullRequest(
  repo: RepoInfo,
  branch: string,
): Promise<PullRequestInfo | null> {
  // `gh pr list --head` works even when the branch has no upstream and no
  // local origin ref, which `gh pr view` cannot always manage.
  const { stdout } = await gh(repo.root, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    "number,title,url,state,isDraft,baseRefName,headRefName,author",
  ]);

  const rows = JSON.parse(stdout || "[]") as Array<{
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    baseRefName: string;
    headRefName: string;
    author: { login: string } | null;
  }>;

  if (rows.length === 0) return null;

  // An open PR is what you're about to push to; fall back to the newest.
  const open = rows.find((r) => r.state === "OPEN");
  const chosen = open ?? rows.sort((a, b) => b.number - a.number)[0];

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
  const { stdout } = await gh(repo.root, [
    "api",
    "graphql",
    "-f",
    `query=${THREADS_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `name=${repo.name}`,
    "-F",
    `number=${number}`,
  ]);

  const parsed = JSON.parse(stdout) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviews?: { nodes: GqlReviewNode[] };
          reviewThreads?: { nodes: GqlThreadNode[] };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  }

  const pull = parsed.data?.repository?.pullRequest;

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
      comments: node.comments.nodes.map(
        (c): ReviewComment => ({
          id: c.id,
          databaseId: c.databaseId,
          author: c.author?.login ?? "ghost",
          avatarUrl: c.author?.avatarUrl ?? null,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
          diffHunk: c.diffHunk,
        }),
      ),
    }),
  );

  // Review summaries with an empty body are just the "approved"/"commented"
  // envelope around inline comments; only the ones with prose are interesting.
  const reviews: ReviewSummary[] = (pull?.reviews?.nodes ?? [])
    .filter((r) => r.body.trim().length > 0)
    .map((r) => ({
      id: r.id,
      author: r.author?.login ?? "ghost",
      body: r.body,
      state: r.state,
      url: r.url,
      createdAt: r.createdAt,
    }));

  return { threads, reviews };
}

function describeGhError(err: unknown): string {
  if (err instanceof ExecError) {
    if (err.code === 127) {
      return "The `gh` CLI isn't on PATH. Install it to see PR comments.";
    }
    const msg = err.message.toLowerCase();
    if (msg.includes("auth") || msg.includes("login")) {
      return "GitHub CLI isn't authenticated. Run `gh auth login`.";
    }
    if (msg.includes("could not resolve to a repository")) {
      return "This repository isn't reachable on GitHub with your current login.";
    }
    return `GitHub lookup failed: ${err.message.split("\n")[0]}`;
  }
  if (err instanceof Error) return `GitHub lookup failed: ${err.message}`;
  return "GitHub lookup failed.";
}
