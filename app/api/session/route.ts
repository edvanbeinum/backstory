import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import {
  getBoundarySha,
  getBranchDiffSummary,
  getCommitRange,
  getCommits,
  hasRemoteRefs,
  getHistory,
  getPatchId,
  getPatchIdMap,
  getWorkingTree,
  isOnBranch,
  resolveBase,
  resolveRepo,
} from "@/lib/git";
import { loadGitHubDataCached, NO_RESPONSE } from "@/lib/github";
import {
  getResponses,
  prKey,
  updateResponses,
  type ResponsePatch,
  type ResponseRecord,
} from "@/lib/responses";
import type { ApiError, ReviewThread, SessionResponse } from "@/lib/types";

/** A branch you're only reading has no working tree of its own. */
const EMPTY_WORKING_TREE = {
  hasChanges: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  untrackedPaths: [],
  changedPaths: [],
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  // fresh=1 bypasses the GitHub cache: the manual refresh button, and
  // watcher events that saw refs/remotes move (a push landed).
  const fresh = searchParams.get("fresh") === "1";
  // A branch to review instead of whatever this worktree has checked out.
  // Reviewing a pushed branch needs no checkout, and a stacked workflow
  // leaves most of the stack as plain branches — without this they're
  // invisible however many review comments they've collected.
  const ref = searchParams.get("ref");

  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "Choose a repository to review.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath, ref);
    const rawBase = await resolveBase(repo);

    // Commits first: the boundary (and so the history walk) is defined by
    // the oldest unpushed commit, not by the raw merge base — after a rebase
    // those don't match, and the boundary is the honest one.
    let commits = await getCommits(repo, rawBase);
    const boundarySha = await getBoundarySha(
      repo.root,
      commits,
      rawBase,
      repo.tip,
    );
    const base: typeof rawBase = {
      ...rawBase,
      boundarySha,
      // When the boundary has moved off the merge base, "ahead of
      // <upstream>" would overstate the count — say what the list now means.
      label:
        boundarySha && rawBase.sha && boundarySha !== rawBase.sha
          ? "not yet on any remote"
          : rawBase.label,
    };

    // GitHub is the slow part and the only one that can fail softly, so let
    // it run alongside the remaining local git work.
    const [history, workingTree, rawGithub, hasRemote] = await Promise.all([
      getHistory(repo, base),
      getWorkingTree(repo),
      loadGitHubDataCached(repo, { fresh }),
      hasRemoteRefs(repo.root),
    ]);

    // Uncommitted work belongs to whatever is checked out here, not to some
    // other branch you happen to be reading. Offering it as an answer to a
    // comment on a different branch would be a lie.
    const working = repo.ref ? EMPTY_WORKING_TREE : workingTree;

    // The branch diff needs the PR's base branch, so it waits on GitHub —
    // a couple of local git commands once that resolves. On a stacked PR
    // the base is the parent branch, not the default branch.
    const branchDiff = await getBranchDiffSummary(
      repo,
      base,
      rawGithub.pr?.baseRefName ?? null,
    );

    // "Not yet pushed" is the wrong axis for a branch you're only reading —
    // it's pushed, that's why it has review comments. What matters is which
    // commits the PR is actually made of, which needs the base GitHub just
    // told us.
    if (repo.ref && branchDiff) {
      commits = await getCommitRange(
        repo,
        `${branchDiff.baseSha}..${repo.ref}`,
      );
      base.label = branchDiff.label;
      base.boundarySha = branchDiff.baseSha;
    }

    // A review left as a top-level body — no inline thread — is still
    // something to address, so it joins the checklist as a thread with no
    // file. Without this a PR whose only feedback is a review summary looks
    // like it has no comments at all.
    const summaryThreads: ReviewThread[] = rawGithub.reviews.map((review) => ({
      id: review.id,
      isResolved: false,
      isOutdated: false,
      path: null,
      line: null,
      originalLine: null,
      startLine: null,
      side: null,
      isReviewSummary: true,
      response: NO_RESPONSE,
      comments: [
        {
          id: review.id,
          databaseId: null,
          author: review.author,
          avatarUrl: review.avatarUrl,
          body: review.body,
          createdAt: review.createdAt,
          url: review.url,
          diffHunk: null,
        },
      ],
    }));

    // Attach your response to each comment. `done` is only ever what you set:
    // Backstory used to guess which commit answered a comment, but a guess
    // always found something, so no comment ever read as outstanding and the
    // list couldn't work as a checklist.
    // Oldest first — the order the reviewer left them, which is the order
    // they read in on the pull request's conversation. Sorting by file and
    // line instead would have been the Files-changed tab's order, and would
    // reshuffle a review into an order nobody wrote or read it in.
    //
    // A review's own body is timestamped too, so it lands where it was
    // submitted rather than being tacked on at the end — which is also where
    // GitHub puts it, above the comments that came with it.
    //
    // Ordered here rather than in the client so the spine, the ‹ › stepper,
    // `j`/`k` and the "first open comment" fallback can't disagree about what
    // "next" means.
    const allThreads = [...rawGithub.threads, ...summaryThreads].sort((a, b) =>
      (a.comments[0]?.createdAt ?? "").localeCompare(
        b.comments[0]?.createdAt ?? "",
      ),
    );
    const github = { ...rawGithub, threads: allThreads };
    if (allThreads.length > 0) {
      const key = rawGithub.pr
        ? prKey(repo.owner, repo.name, rawGithub.pr.number)
        : null;
      const responses: Record<string, ResponseRecord> = key
        ? await getResponses(key)
        : {};

      const linked = Object.entries(responses).filter(
        ([, record]) => record.commits.length > 0,
      );

      // A rebase rewrites shas, so a link can outlive its commit. Ask whether
      // each sha is still *reachable from HEAD* — not merely whether the
      // object exists, since rebased-away commits linger in the object
      // database and would otherwise pass as healthy.
      const alive = new Map<string, boolean>();
      for (const [, record] of linked) {
        for (const { sha } of record.commits) {
          if (alive.has(sha)) continue;
          alive.set(sha, await isOnBranch(repo.root, sha, repo.tip));
        }
      }

      // Links made before patch-ids existed have none stored, which would
      // leave them unable to survive the next rebase. Backfill quietly while
      // the commit is still reachable. Collected then written in a single
      // batch: separate writes would race each other through the same file.
      //
      // Note what these patches never contain: `done`. Healing may move or
      // break a link, but it must never touch the tick — a rebase can't undo
      // a judgement you made.
      if (key) {
        const backfill: Record<string, ResponsePatch> = {};
        for (const [threadId, record] of linked) {
          let changed = false;
          const filled = await Promise.all(
            record.commits.map(async (commit) => {
              if (commit.patchId || !alive.get(commit.sha)) return commit;
              const found = await getPatchId(repo.root, commit.sha);
              if (!found) return commit;
              changed = true;
              return { sha: commit.sha, patchId: found };
            }),
          );
          if (changed) {
            responses[threadId] = { ...record, commits: filled };
            backfill[threadId] = { commits: filled };
          }
        }
        await updateResponses(key, backfill);
      }

      // Anything still missing may just have been rebased. A commit's
      // patch-id hashes its diff alone, so a rewritten commit keeps it —
      // find the new sha rather than making the user re-link. Only computed
      // when something is actually broken.
      // Healed shas, not thread ids: one comment can carry several links and
      // only some of them will have been rebased away.
      const healed = new Set<string>();
      const stale = Object.entries(responses).filter(([, record]) =>
        record.commits.some((c) => !alive.get(c.sha) && c.patchId),
      );
      if (stale.length > 0 && branchDiff && key) {
        const patchIds = await getPatchIdMap(
          repo.root,
          `${branchDiff.baseSha}..${repo.tip}`,
        );
        const moves: Record<string, ResponsePatch> = {};
        for (const [threadId, record] of stale) {
          let changed = false;
          const moved = record.commits.map((commit) => {
            if (alive.get(commit.sha) || !commit.patchId) return commit;
            // null = the patch-id appears more than once on the branch, so
            // the match is ambiguous; leave it broken and let the user decide.
            const match = patchIds.get(commit.patchId);
            if (!match) return commit;
            alive.set(match, true);
            healed.add(match);
            changed = true;
            return { sha: match, patchId: commit.patchId };
          });
          if (changed) {
            responses[threadId] = { ...record, commits: moved };
            moves[threadId] = { commits: moved };
          }
        }
        await updateResponses(key, moves);
      }

      github.threads = allThreads.map((thread) => {
        const record = responses[thread.id];
        if (!record) return { ...thread, response: NO_RESPONSE };

        return {
          ...thread,
          response: {
            done: record.done,
            doneAt: record.doneAt,
            reply: record.reply,
            commits: record.commits.map((commit) => ({
              sha: commit.sha,
              shortSha: commit.sha.slice(0, 7),
              missing: !alive.get(commit.sha),
              healed: healed.has(commit.sha),
            })),
          },
        };
      });
    }

    const body: SessionResponse = {
      repo,
      base,
      commits,
      history,
      hasRemote,
      working,
      github,
      branchDiff,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
