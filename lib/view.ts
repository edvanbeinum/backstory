import { BRANCH_REV, WORKING_REV } from "./constants";
import { gitLine } from "./exec";
import { getBranchDiffBase, resolveBase, resolveRev } from "./git";
import { loadGitHubDataCached } from "./github";
import type { RepoInfo } from "./types";

/**
 * The two commits a view compares, the same ones /api/diff diffs: a commit
 * and its first parent, or for "All changes" the branch's fork point and
 * `repo.tip`: the branch the repo was opened to review, or HEAD. Null for
 * uncommitted work, which has no commit to key anything on.
 */
export async function viewRange(
  repo: RepoInfo,
  rev: string,
): Promise<{ base: string | null; head: string } | null> {
  if (rev === WORKING_REV) return null;
  if (rev === BRANCH_REV) {
    const github = await loadGitHubDataCached(repo);
    const info = await getBranchDiffBase(
      repo,
      await resolveBase(repo),
      github.pr?.baseRefName ?? null,
    );
    const head = await resolveRev(repo.root, repo.tip);
    if (!info || !head) return null;
    return { base: info.baseSha, head };
  }
  const head = await resolveRev(repo.root, rev);
  if (!head) return null;
  const base = await gitLine(repo.root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${head}^1`,
  ]);
  return { base, head };
}
