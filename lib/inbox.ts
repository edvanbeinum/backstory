import path from "node:path";

import { listWorktrees } from "./browse";
import { run } from "./exec";
import { parseRemote } from "./git";
import { describeGhError, gh, pickPullRequest } from "./github";
import { countProgress, type Progress } from "./progress";
import { getAllResponses, prKey } from "./responses";

/**
 * The inbox: every worktree you've got checked out, across every repo you've
 * opened, with how much of each PR's review you've worked through.
 *
 * The cost is the interesting part. The obvious build — resolve each worktree,
 * find its PR, fetch its threads — is two network round trips *per worktree*,
 * so twenty worktrees is twenty seconds of GitHub latency before the home
 * screen paints. Instead one aliased GraphQL query asks for every branch of a
 * repo at once, which makes the whole screen **one `gh` call per repository**:
 * measured at 0.48s for ten branches. Everything else is local git.
 */

export interface InboxPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  /** Threads GitHub still calls unresolved. Shown, never used to tick. */
  unresolved: number;
}

export interface InboxRow {
  /** Stable identity, and what the client opens. */
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  /** Which repo group this belongs to. */
  repo: string;
  /** Registered but the directory is gone. */
  missing: boolean;
  /** The repo's own checkout rather than a sibling worktree. */
  isMain: boolean;
  /** Commits ahead of upstream, null when the branch has no upstream. */
  ahead: number | null;
  lastCommitAt: string | null;
  pr: InboxPr | null;
  progress: Progress | null;
}

export interface InboxRepo {
  /** Canonical identity — the same for every worktree of one repo. */
  commonDir: string;
  root: string;
  owner: string | null;
  name: string | null;
  label: string;
  /** gh missing, unauthenticated, no remote… Rows are still returned. */
  unavailable: string | null;
  /** Served from cache after a live failure, so the counts may lag. */
  stale: boolean;
}

export interface InboxResult {
  repos: InboxRepo[];
  rows: InboxRow[];
  /** Requested paths that no longer resolve — offer to forget them. */
  unresolved: Array<{ path: string; error: string }>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["--no-pager", ...args], {
      cwd,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `--git-common-dir` is identical for every worktree of a repository, so it
 * groups a list of remembered worktree paths into repos in one call each.
 * Without it, opening twenty sibling worktrees would scan the same repo
 * twenty times.
 */
async function identify(
  dir: string,
): Promise<{ commonDir: string; root: string } | null> {
  const out = await git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
  ]);
  if (!out) return null;
  const [commonDir, root] = out.split("\n");
  if (!commonDir || !root) return null;
  return { commonDir, root };
}

interface BranchFacts {
  ahead: number | null;
  lastCommitAt: string | null;
}

/**
 * Ahead-count and last-commit date for every branch in the repo, in one call.
 * Per-worktree this would be a `rev-list` each; here it's free.
 */
async function branchFacts(root: string): Promise<Map<string, BranchFacts>> {
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream:track)%09%(committerdate:iso8601)",
    "refs/heads/",
  ]);
  const facts = new Map<string, BranchFacts>();
  if (!out) return facts;

  for (const line of out.split("\n")) {
    const [name, track, date] = line.split("\t");
    if (!name) continue;
    // "[ahead 3]", "[ahead 3, behind 1]", "[gone]", or empty.
    const ahead = track?.match(/ahead (\d+)/);
    facts.set(name, {
      ahead: ahead ? Number(ahead[1]) : track === "" ? 0 : null,
      lastCommitAt: date || null,
    });
  }
  return facts;
}

const FRAGMENT = `
fragment F on PullRequest {
  number title state isDraft url updatedAt
  isCrossRepository
  headRepositoryOwner { login }
  reviewThreads(first: 100) { totalCount nodes { id isResolved } }
  reviews(first: 50) { nodes { id body } }
}`;

interface GqlInboxPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  updatedAt: string;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
  reviewThreads: { totalCount: number; nodes: Array<{ id: string; isResolved: boolean }> };
  reviews: { nodes: Array<{ id: string; body: string }> };
}

/** One request, one alias per branch. Chunked so the node budget can't bite. */
const CHUNK = 25;

async function loadPullRequests(
  root: string,
  owner: string,
  name: string,
  branches: string[],
): Promise<Map<string, GqlInboxPr[]>> {
  const found = new Map<string, GqlInboxPr[]>();

  for (let start = 0; start < branches.length; start += CHUNK) {
    const slice = branches.slice(start, start + CHUNK);
    const decls = slice.map((_, i) => `$b${i}: String!`).join(", ");
    const fields = slice
      .map(
        (_, i) =>
          `    w${i}: pullRequests(headRefName: $b${i}, first: 3, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...F } }`,
      )
      .join("\n");

    const query = `${FRAGMENT}
query($owner: String!, $name: String!, ${decls}) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}`;

    // Branch names ride in as variables, never interpolated into the query.
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      ...slice.flatMap((branch, i) => ["-F", `b${i}=${branch}`]),
    ];

    const { stdout } = await gh(root, args);
    const parsed = JSON.parse(stdout) as {
      data?: { repository?: Record<string, { nodes: GqlInboxPr[] }> };
      errors?: Array<{ message: string }>;
    };
    if (parsed.errors?.length) {
      throw new Error(parsed.errors.map((e) => e.message).join("; "));
    }

    const repository = parsed.data?.repository ?? {};
    slice.forEach((branch, i) => {
      found.set(branch, repository[`w${i}`]?.nodes ?? []);
    });
  }

  return found;
}

interface RepoSlice {
  prs: Map<string, GqlInboxPr[]>;
}

/**
 * Keyed by repo *and* the branch set, so checking out a new worktree busts it
 * — that's the only thing that changes the query. 60s, and only the explicit
 * refresh button bypasses: the app window fires focus constantly, and passing
 * `fresh` from there would turn the home screen into a GitHub poller.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; slice: RepoSlice }>();

export async function buildInbox(
  roots: string[],
  opts: { fresh?: boolean } = {},
): Promise<InboxResult> {
  const unresolved: Array<{ path: string; error: string }> = [];
  const groups = new Map<string, { commonDir: string; root: string }>();

  await Promise.all(
    roots.map(async (dir) => {
      const identity = await identify(dir);
      if (!identity) {
        unresolved.push({ path: dir, error: "Not a git repository any more." });
        return;
      }
      groups.set(identity.commonDir, identity);
    }),
  );

  const results = await Promise.all(
    [...groups.values()].map((identity) => buildRepo(identity, opts)),
  );

  // Most outstanding first, then alphabetically — Promise.all resolves in
  // whatever order the network felt like, which is no order at all.
  const outstanding = (rows: InboxRow[]) =>
    rows.reduce(
      (n, row) => n + (row.progress ? row.progress.total - row.progress.done : 0),
      0,
    );
  results.sort(
    (a, b) =>
      outstanding(b.rows) - outstanding(a.rows) ||
      a.repo.label.localeCompare(b.repo.label),
  );

  return {
    repos: results.map((r) => r.repo),
    rows: results.flatMap((r) => r.rows),
    unresolved,
  };
}

async function buildRepo(
  identity: { commonDir: string; root: string },
  opts: { fresh?: boolean },
): Promise<{ repo: InboxRepo; rows: InboxRow[] }> {
  const { commonDir, root } = identity;
  const label = path.basename(root);

  const [worktrees, facts, remoteUrl, responses] = await Promise.all([
    listWorktrees(root),
    branchFacts(root),
    git(root, ["remote", "get-url", "origin"]),
    getAllResponses(),
  ]);

  const { owner, name } = parseRemote(remoteUrl);
  const repo: InboxRepo = {
    commonDir,
    root,
    owner,
    name,
    label: name ?? label,
    unavailable: null,
    stale: false,
  };

  const branches = worktrees
    .map((w) => w.branch)
    .filter((b): b is string => Boolean(b));

  let prs = new Map<string, GqlInboxPr[]>();
  if (!owner || !name) {
    repo.unavailable = "No GitHub remote — showing local branches only.";
  } else if (branches.length > 0) {
    const key = `${owner}/${name} ${[...branches].sort().join(",")}`;
    const hit = cache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) {
      prs = hit.slice.prs;
    } else {
      try {
        prs = await loadPullRequests(root, owner, name, branches);
        cache.set(key, { at: Date.now(), slice: { prs } });
      } catch (err) {
        repo.unavailable = describeGhError(err);
        // Any cached copy, at any age, beats a blank screen: the difference
        // between "GitHub blipped" and "your work disappeared".
        if (hit) {
          prs = hit.slice.prs;
          repo.stale = true;
        }
      }
    }
  }

  const rows = worktrees.map((worktree): InboxRow => {
    const fact = worktree.branch ? facts.get(worktree.branch) : undefined;
    const chosen = worktree.branch
      ? pickPullRequest(prs.get(worktree.branch) ?? [], owner)
      : null;

    let pr: InboxPr | null = null;
    let progress: Progress | null = null;

    if (chosen) {
      pr = {
        number: chosen.number,
        title: chosen.title,
        state: chosen.state,
        isDraft: chosen.isDraft,
        url: chosen.url,
        unresolved: chosen.reviewThreads.nodes.filter((t) => !t.isResolved)
          .length,
      };

      const key = prKey(owner, name, chosen.number);
      // An empty review body is the envelope around inline comments, not
      // something to respond to.
      const ids = [
        ...chosen.reviewThreads.nodes.map((t) => t.id),
        ...chosen.reviews.nodes
          .filter((r) => r.body.trim().length > 0)
          .map((r) => r.id),
      ];
      progress = countProgress(ids, key ? (responses[key] ?? {}) : {}, {
        reportedTotal:
          chosen.reviewThreads.totalCount + (ids.length - chosen.reviewThreads.nodes.length),
      });
    }

    return {
      path: worktree.path,
      name: worktree.name,
      branch: worktree.branch,
      head: worktree.head ?? null,
      repo: commonDir,
      missing: Boolean(worktree.missing),
      isMain: worktree.path === root,
      ahead: fact?.ahead ?? null,
      lastCommitAt: fact?.lastCommitAt ?? null,
      pr,
      progress,
    };
  });

  // Outstanding work first, then whatever moved most recently. A finished
  // branch shouldn't sit above one waiting on you.
  rows.sort((a, b) => {
    const aLeft = a.progress ? a.progress.total - a.progress.done : -1;
    const bLeft = b.progress ? b.progress.total - b.progress.done : -1;
    if (aLeft !== bLeft) return bLeft - aLeft;
    return (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "");
  });

  return { repo, rows };
}
