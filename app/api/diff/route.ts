import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import { parseUnifiedDiff, totals } from "@/lib/diff";
import {
  getBranchDiffBase,
  getCommitPatch,
  getRangePatch,
  getWorkingPatch,
  getWorkingTree,
  isMergeCommit,
  resolveBase,
  resolveRepo,
  resolveRev,
} from "@/lib/git";
import { loadGitHubDataCached } from "@/lib/github";
import { highlightFiles } from "@/lib/highlight";
import type { ApiError, DiffResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const rev = searchParams.get("rev");
  // Optional: scope the diff to particular paths. The comment view renders
  // one file, so shipping the whole 13-file diff to show it would be waste.
  // Renames send both names, as in /api/file.
  const paths = searchParams.getAll("path").filter(Boolean);
  const pathspec = paths.length > 0 ? paths : undefined;

  if (!repoPath || !rev) {
    return NextResponse.json<ApiError>(
      { error: "Both `repo` and `rev` are required.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath, searchParams.get("ref"));

    let patch: string;
    if (rev === WORKING_REV) {
      const working = await getWorkingTree(repo);
      patch = await getWorkingPatch(repo.root, working.untrackedPaths, {
        pathspec,
      });
    } else if (rev === BRANCH_REV) {
      // The combined branch diff: fork point (or push boundary) → the tip.
      // The PR's base branch decides the fork — on a stacked PR that's the
      // parent branch, not the default one. Cached, so usually free.
      const github = await loadGitHubDataCached(repo);
      const info = await getBranchDiffBase(
        repo,
        await resolveBase(repo),
        github.pr?.baseRefName ?? null,
      );
      if (!info) {
        return NextResponse.json<ApiError>(
          { error: "Nothing to diff the branch against.", kind: "git" },
          { status: 404 },
        );
      }
      patch = await getRangePatch(repo.root, info.baseSha, repo.tip, {
        pathspec,
      });
    } else {
      const sha = await resolveRev(repo.root, rev);
      if (!sha) {
        return NextResponse.json<ApiError>(
          { error: `No such commit: ${rev}`, kind: "git" },
          { status: 404 },
        );
      }
      patch = await getCommitPatch(
        repo.root,
        sha,
        await isMergeCommit(repo.root, sha),
        { pathspec },
      );
    }

    const files = parseUnifiedDiff(patch);
    const highlighted = await highlightFiles(files);
    const { additions, deletions } = totals(files);

    const body: DiffResponse = {
      rev,
      files,
      additions,
      deletions,
      highlightSkipped: !highlighted,
    };

    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
