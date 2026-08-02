import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import {
  getBoundarySha,
  getBranchDiffSummary,
  getCommits,
  getHistory,
  getWorkingTree,
  resolveBase,
  resolveRepo,
} from "@/lib/git";
import { loadGitHubDataCached } from "@/lib/github";
import type { ApiError, SessionResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  // fresh=1 bypasses the GitHub cache: the manual refresh button, and
  // watcher events that saw refs/remotes move (a push landed).
  const fresh = searchParams.get("fresh") === "1";

  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "Choose a repository to review.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath);
    const rawBase = await resolveBase(repo);

    // Commits first: the boundary (and so the history walk) is defined by
    // the oldest unpushed commit, not by the raw merge base — after a rebase
    // those differ, and the boundary is the honest one.
    const commits = await getCommits(repo, rawBase);
    const boundarySha = await getBoundarySha(repo.root, commits, rawBase);
    const base = {
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
    const [history, working, github, branchDiff] = await Promise.all([
      getHistory(repo, base),
      getWorkingTree(repo),
      loadGitHubDataCached(repo, { fresh }),
      getBranchDiffSummary(repo, base),
    ]);

    const body: SessionResponse = {
      repo,
      base,
      commits,
      history,
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
