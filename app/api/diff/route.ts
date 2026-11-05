import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { BRANCH_REV, STACK_REV, WORKING_REV } from "@/lib/constants";
import { parseUnifiedDiff, totals } from "@/lib/diff";
import {
  getCommitPatch,
  getRangePatch,
  getWorkingPatch,
  getWorkingTree,
  isMergeCommit,
  resolveRepo,
  resolveRev,
} from "@/lib/git";
import { highlightFiles } from "@/lib/highlight";
import type { ApiError, DiffResponse } from "@/lib/types";
import { viewRange } from "@/lib/view";

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
    if (rev === WORKING_REV && repo.ref) {
      // Return nothing for a branch opened by ref: the checkout's uncommitted
      // work belongs to another branch, and /api/session reports none.
      patch = "";
    } else if (rev === WORKING_REV) {
      const working = await getWorkingTree(repo);
      patch = await getWorkingPatch(repo.root, working.untrackedPaths, {
        pathspec,
      });
    } else if (rev === BRANCH_REV || rev === STACK_REV) {
      const range = await viewRange(repo, rev);
      if (!range?.base) {
        return NextResponse.json<ApiError>(
          { error: "Nothing to diff the branch against.", kind: "git" },
          { status: 404 },
        );
      }
      patch = await getRangePatch(repo.root, range.base, range.head, {
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
