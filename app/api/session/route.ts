import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import {
  getBoundarySha,
  getBranchDiffSummary,
  getCommitRange,
  getCommits,
  hasRemoteRefs,
  getHistory,
  getWorkingTree,
  resolveBase,
  resolveRepo,
} from "@/lib/git";
import { loadGitHubDataCached } from "@/lib/github";
import type { ApiError, ReviewThread, SessionResponse } from "@/lib/types";

/** A branch you're only reading has no working tree of its own. */
const EMPTY_WORKING_TREE = {
  hasChanges: false,
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
    // feedback, so it joins the comments as a thread with no file. Without
    // this a PR whose only feedback is a review summary looks like it has no
    // comments at all.
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

    // Oldest first — the order the reviewer left them, which is the order
    // they read in on the pull request's conversation. Sorting by file and
    // line instead would have been the Files-changed tab's order, and would
    // reshuffle a review into an order nobody wrote or read it in.
    //
    // A review's own body is timestamped too, so it lands where it was
    // submitted rather than being tacked on at the end — which is also where
    // GitHub puts it, above the comments that came with it.
    //
    // Ordered here rather than in the client so the 💬 numbers in Files
    // changed, "Comment i of N" and `j`/`k` can't disagree about the order.
    const threads = [...rawGithub.threads, ...summaryThreads].sort((a, b) =>
      (a.comments[0]?.createdAt ?? "").localeCompare(
        b.comments[0]?.createdAt ?? "",
      ),
    );
    const github = { ...rawGithub, threads };

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
