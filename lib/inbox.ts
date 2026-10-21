import path from "node:path";

import { listWorktrees } from "./browse";
import { run } from "./exec";
import { parseRemote } from "./git";
import { describeGhError, githubGraphql, pickPullRequest } from "./github";

/**
 * The inbox: every worktree you've got checked out, across every repo you've
 * opened, with how many of each PR's review threads GitHub calls unresolved.
 *
 * The cost is the interesting part. The obvious build — resolve each worktree,
 * find its PR, fetch its threads — is two network round trips *per worktree*,
 * so twenty worktrees is twenty seconds of GitHub latency before the home
 * screen paints. Instead one aliased GraphQL query asks for every branch of a
 * repo at once, which makes the whole screen **one GitHub call per repository**:
 * measured at 0.48s for ten branches. Everything else is local git.
 */

export interface InboxPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  /** What this PR targets — another branch here, when it's a stack. */
  baseRefName: string;
  /** Threads GitHub still calls unresolved. */
  unresolved: number;
}

export interface InboxRow {
  /** Stable identity: the branch, or the path for a detached worktree. */
  id: string;
  branch: string | null;
  /** The worktree holding it, when one does. */
  worktree: { path: string; name: string; missing: boolean } | null;
  /**
   * The worktree Backstory reviews it from. Its own when checked out, otherwise
   * the repo's main checkout — git reads any ref from any worktree, so a
   * branch needs no checkout of its own to be reviewed.
   */
  reviewPath: string;
  head: string | null;
  /** Which repo group this belongs to. */
  repo: string;
  /** The repo's own checkout rather than a sibling worktree. */
  isMain: boolean;
  /** Commits ahead of upstream, null when the branch has no upstream. */
  ahead: number | null;
  lastCommitAt: string | null;
  pr: InboxPr | null;
  /** How deep in a stack of PRs, from the base each one targets. */
  depth: number;
  /**
   * Merged or closed: the review is over. Kept rather than dropped — three
   * of these are worktrees still on disk, and this is the only screen that
   * lists what you have checked out — but it doesn't count and doesn't compete for the top of the list.
   */
  archived: boolean;
}

/** A branch on GitHub this clone has no local branch for. */
export interface RemoteBranch {
  branch: string;
  lastCommitAt: string | null;
  pr: {
    number: number;
    title: string;
    author: string | null;
    isDraft: boolean;
    baseRefName: string;
    url: string;
  } | null;
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
  /** The fix is Connect GitHub, so the inbox links to the setup checklist */
  connect: boolean;
  /** Served from cache after a live failure, so the counts may lag. */
  stale: boolean;
  /**
   * Open same-repo PRs first, most recently updated first, then branches
   * without one, newest commit first.
   */
  onGitHub: RemoteBranch[];
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
  number title state isDraft url updatedAt baseRefName
  isCrossRepository
  headRepositoryOwner { login }
  reviewThreads(first: 100) { nodes { isResolved } }
}`;

interface GqlInboxPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  updatedAt: string;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
  reviewThreads: { nodes: Array<{ isResolved: boolean }> };
}

interface GqlOpenPr {
  number: number;
  title: string;
  isDraft: boolean;
  url: string;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  author: { login: string } | null;
  headRef: { target: { committedDate?: string } | null } | null;
}

interface GqlHead {
  name: string;
  target: { committedDate?: string } | null;
}

/**
 * What the first chunk also asks for, for On GitHub. Asked even with no
 * local branches, so a fresh clone still lists its teammates' work.
 */
const ON_GITHUB = `
    open: pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title isDraft url baseRefName headRefName isCrossRepository
        author { login }
        headRef { target { ... on Commit { committedDate } } }
      }
    }
    heads: refs(refPrefix: "refs/heads/", first: 100) {
      nodes { name target { ... on Commit { committedDate } } }
    }
    defaultBranchRef { name }`;

interface Loaded {
  prs: Map<string, GqlInboxPr[]>;
  open: GqlOpenPr[];
  heads: GqlHead[];
  defaultBranch: string | null;
}

/** One request, one alias per branch. Chunked so the node budget can't bite. */
const CHUNK = 25;

async function loadPullRequests(
  root: string,
  host: string | null,
  owner: string,
  name: string,
  branches: string[],
): Promise<Loaded> {
  const loaded: Loaded = {
    prs: new Map(),
    open: [],
    heads: [],
    defaultBranch: null,
  };

  for (let start = 0; start === 0 || start < branches.length; start += CHUNK) {
    const slice = branches.slice(start, start + CHUNK);
    const decls = [
      "$owner: String!",
      "$name: String!",
      ...slice.map((_, i) => `$b${i}: String!`),
    ].join(", ");
    const fields = slice
      .map(
        (_, i) =>
          `    w${i}: pullRequests(headRefName: $b${i}, first: 3, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...F } }`,
      )
      .join("\n");

    const query = `${FRAGMENT}
query(${decls}) {
  repository(owner: $owner, name: $name) {
${fields}${start === 0 ? ON_GITHUB : ""}
  }
}`;

    // Branch names ride in as variables, never interpolated into the query.
    const data = await githubGraphql<{
      repository?: Record<string, unknown> & {
        open?: { nodes: GqlOpenPr[] };
        heads?: { nodes: GqlHead[] };
        defaultBranchRef?: { name: string } | null;
      };
    }>(
      root,
      query,
      {
        owner,
        name,
        ...Object.fromEntries(slice.map((branch, i) => [`b${i}`, branch])),
      },
      { host },
    );

    const repository = data?.repository ?? {};
    slice.forEach((branch, i) => {
      const alias = repository[`w${i}`] as { nodes: GqlInboxPr[] } | undefined;
      loaded.prs.set(branch, alias?.nodes ?? []);
    });
    if (start === 0) {
      loaded.open = repository.open?.nodes ?? [];
      loaded.heads = repository.heads?.nodes ?? [];
      loaded.defaultBranch = repository.defaultBranchRef?.name ?? null;
    }
  }

  return loaded;
}

/**
 * The branches On GitHub offers: same-repo open PRs, then plain branches,
 * minus anything with a local branch and the default branch. A fork's PR is
 * left out, because its branch isn't on origin to fetch.
 */
function remoteBranches(loaded: Loaded, local: Set<string>): RemoteBranch[] {
  const taken = new Set(local);
  if (loaded.defaultBranch) taken.add(loaded.defaultBranch);
  const out: RemoteBranch[] = [];

  for (const pr of loaded.open) {
    if (pr.isCrossRepository || taken.has(pr.headRefName)) continue;
    taken.add(pr.headRefName);
    out.push({
      branch: pr.headRefName,
      lastCommitAt: pr.headRef?.target?.committedDate ?? null,
      pr: {
        number: pr.number,
        title: pr.title,
        author: pr.author?.login ?? null,
        isDraft: pr.isDraft,
        baseRefName: pr.baseRefName,
        url: pr.url,
      },
    });
  }
  // Sorts here, because GitHub orders branches by name: its commit-date order
  // applies only to tags.
  const heads = [...loaded.heads].sort((a, b) =>
    (b.target?.committedDate ?? "").localeCompare(
      a.target?.committedDate ?? "",
    ),
  );
  for (const head of heads) {
    if (taken.has(head.name)) continue;
    taken.add(head.name);
    out.push({
      branch: head.name,
      lastCommitAt: head.target?.committedDate ?? null,
      pr: null,
    });
  }
  return out;
}

/**
 * Keyed by repo *and* the branch set, so checking out a new worktree busts it
 * — that's the only thing that changes the query. 60s, and only the explicit
 * refresh button bypasses: the app window fires focus constantly, and passing
 * `fresh` from there would turn the home screen into a GitHub poller.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; slice: Loaded }>();

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

  // Most unresolved first, then alphabetically — Promise.all resolves in
  // whatever order the network felt like, which is no order at all.
  // Only live PRs count: a merged one's threads often stay unresolved, and
  // letting them count made the headline three times the real number.
  const total = (rows: InboxRow[]) =>
    rows.reduce((n, row) => n + unresolvedIn(row), 0);
  results.sort(
    (a, b) =>
      total(b.rows) - total(a.rows) || a.repo.label.localeCompare(b.repo.label),
  );

  return {
    repos: results.map((r) => r.repo),
    rows: results.flatMap((r) => r.rows),
    unresolved,
  };
}

/** A live PR's unresolved threads; zero for an archived row or one with no PR. */
function unresolvedIn(row: InboxRow): number {
  return row.archived || !row.pr ? 0 : row.pr.unresolved;
}

async function buildRepo(
  identity: { commonDir: string; root: string },
  opts: { fresh?: boolean },
): Promise<{ repo: InboxRepo; rows: InboxRow[] }> {
  const { commonDir } = identity;
  // The repo's own checkout, derived from the common dir rather than from
  // whichever path happened to be scanned. Remembering a linked worktree
  // instead would mean deleting that worktree quietly drops the whole repo
  // off the inbox.
  const root = commonDir.endsWith("/.git")
    ? path.dirname(commonDir)
    : identity.root;
  const label = path.basename(root);

  const [worktrees, facts, remoteUrl] = await Promise.all([
    listWorktrees(root),
    branchFacts(root),
    git(root, ["remote", "get-url", "origin"]),
  ]);

  const { host, owner, name } = parseRemote(remoteUrl);
  const repo: InboxRepo = {
    commonDir,
    root,
    owner,
    name,
    label: name ?? label,
    unavailable: null,
    connect: false,
    stale: false,
    onGitHub: [],
  };

  // Every local branch, not just the checked-out ones. A stacked workflow
  // keeps most of the stack as plain branches — asking only about worktrees
  // hid five open PRs with review comments on them. It costs nothing extra:
  // the query is one call however many aliases it carries.
  const branches = [
    ...new Set([
      ...worktrees.map((w) => w.branch).filter((b): b is string => Boolean(b)),
      ...facts.keys(),
    ]),
  ];

  let prs = new Map<string, GqlInboxPr[]>();
  if (!owner || !name) {
    repo.unavailable = "No GitHub remote — showing local branches only.";
  } else {
    const key = `${owner}/${name} ${[...branches].sort().join(",")}`;
    const hit = cache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) {
      prs = hit.slice.prs;
      repo.onGitHub = remoteBranches(hit.slice, new Set(facts.keys()));
    } else {
      try {
        const loaded = await loadPullRequests(
          root,
          host,
          owner,
          name,
          branches,
        );
        cache.set(key, { at: Date.now(), slice: loaded });
        prs = loaded.prs;
        repo.onGitHub = remoteBranches(loaded, new Set(facts.keys()));
      } catch (err) {
        const { message, connect } = describeGhError(err);
        repo.unavailable = message;
        repo.connect = connect;
        // Any cached copy, at any age, beats a blank screen: the difference
        // between "GitHub blipped" and "your work disappeared".
        if (hit) {
          prs = hit.slice.prs;
          repo.stale = true;
        }
      }
    }
  }

  const byBranch = new Map<string, (typeof worktrees)[number]>();
  for (const worktree of worktrees) {
    if (worktree.branch) byBranch.set(worktree.branch, worktree);
  }

  const build = (
    branch: string | null,
    worktree: (typeof worktrees)[number] | null,
  ): InboxRow => {
    const fact = branch ? facts.get(branch) : undefined;
    const chosen = branch
      ? pickPullRequest(prs.get(branch) ?? [], owner)
      : null;

    const pr: InboxPr | null = chosen
      ? {
          number: chosen.number,
          title: chosen.title,
          state: chosen.state,
          isDraft: chosen.isDraft,
          url: chosen.url,
          baseRefName: chosen.baseRefName,
          unresolved: chosen.reviewThreads.nodes.filter((t) => !t.isResolved)
            .length,
        }
      : null;

    return {
      id: branch ?? worktree?.path ?? "",
      branch,
      worktree: worktree
        ? {
            path: worktree.path,
            name: worktree.name,
            missing: Boolean(worktree.missing),
          }
        : null,
      // Without a checkout of its own, review it from the repo's own — git
      // reads any ref from any worktree of the repo.
      reviewPath: worktree?.path ?? root,
      head: worktree?.head ?? null,
      repo: commonDir,
      isMain: worktree ? worktree.path === root : false,
      ahead: fact?.ahead ?? null,
      lastCommitAt: fact?.lastCommitAt ?? null,
      pr,
      depth: 0,
      archived: pr !== null && (pr.state === "MERGED" || pr.state === "CLOSED"),
    };
  };

  const rows: InboxRow[] = [
    // Every worktree, so a branchless or PR-less checkout still shows.
    ...worktrees.map((worktree) => build(worktree.branch, worktree)),
    // Plus any branch with a PR that no worktree holds. Without a PR it's
    // just a local branch — a `backup/*` or a scratch name — and listing
    // those would bury the ones under review.
    ...branches
      .filter((branch) => !byBranch.has(branch))
      .map((branch) => build(branch, null))
      .filter((row) => row.pr !== null),
  ];

  // Nested separately so an open PR whose base has already merged still
  // reads at the top level rather than indenting under something that isn't
  // in the list any more.
  return {
    repo,
    rows: [
      ...nest(rows.filter((r) => !r.archived)),
      ...nest(rows.filter((r) => r.archived)),
    ],
  };
}

/**
 * Order a repo's rows so a stack reads as a stack.
 *
 * A stacked PR targets the branch below it rather than the default branch, so
 * `baseRefName` already describes the tree — it just has to be walked.
 * Without this, seven dependent PRs sort as seven unrelated rows and nothing
 * says which end to start from.
 */
function nest(rows: InboxRow[]): InboxRow[] {
  // Only a row that is itself a PR can be a stack parent. Otherwise every PR
  // targeting the default branch would indent under the trunk's own row,
  // which adds a level of nesting that says nothing.
  const byBranch = new Map(
    rows.filter((r) => r.branch && r.pr).map((r) => [r.branch as string, r]),
  );
  const children = new Map<string, InboxRow[]>();
  const roots: InboxRow[] = [];

  for (const row of rows) {
    const base = row.pr?.baseRefName;
    // A base that isn't itself listed here is the default branch, or a branch
    // you don't have — either way this row is a root.
    const parent = base && base !== row.branch ? byBranch.get(base) : undefined;
    if (parent) {
      children.set(parent.branch as string, [
        ...(children.get(parent.branch as string) ?? []),
        row,
      ]);
    } else {
      roots.push(row);
    }
  }

  // Rank a row with no live PR below an open PR with nothing unresolved, so a
  // scratch worktree committed today doesn't sit above a PR waiting on review.
  const rank = (row: InboxRow) =>
    row.archived || !row.pr ? -1 : row.pr.unresolved;
  const order = (a: InboxRow, b: InboxRow) =>
    rank(b) - rank(a) ||
    (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "");

  const out: InboxRow[] = [];
  const walk = (row: InboxRow, depth: number) => {
    // A cycle can't happen through PR bases, but a malformed one shouldn't
    // hang the home screen.
    if (out.length > rows.length) return;
    out.push({ ...row, depth });
    for (const child of (children.get(row.branch ?? "") ?? []).sort(order)) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots.sort(order)) walk(root, 0);

  // Anything the walk missed (a cycle) still has to appear.
  for (const row of rows) {
    if (!out.some((r) => r.id === row.id)) out.push({ ...row, depth: 0 });
  }
  return out;
}
