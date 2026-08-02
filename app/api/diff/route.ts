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
import { highlightFiles } from "@/lib/highlight";
import type { ApiError, DiffResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const rev = searchParams.get("rev");

  if (!repoPath || !rev) {
    return NextResponse.json<ApiError>(
      { error: "Both `repo` and `rev` are required.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath);

    let patch: string;
    if (rev === WORKING_REV) {
      const working = await getWorkingTree(repo);
      patch = await getWorkingPatch(repo.root, working.untrackedPaths);
    } else if (rev === BRANCH_REV) {
      // The combined branch diff: fork point (or push boundary) → HEAD.
      const info = await getBranchDiffBase(repo, await resolveBase(repo));
      if (!info) {
        return NextResponse.json<ApiError>(
          { error: "Nothing to diff the branch against.", kind: "git" },
          { status: 404 },
        );
      }
      patch = await getRangePatch(repo.root, info.baseSha, "HEAD");
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
