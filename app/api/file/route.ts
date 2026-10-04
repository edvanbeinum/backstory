import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import { parseUnifiedDiff } from "@/lib/diff";
import {
  FULL_CONTEXT,
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
import {
  highlightFiles,
  MAX_HIGHLIGHT_LINES_SINGLE_FILE,
} from "@/lib/highlight";
import type { ApiError, FileViewResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refuse to render a file this big rather than hang the browser on it. */
const MAX_FILE_LINES = 50_000;

/**
 * One file at full context: the same patch as /api/diff, but with -U large
 * enough that every line of the file lands in a single hunk. The response is
 * an ordinary DiffFile, so the client renders it with the same component and
 * review threads keep anchoring to the same line numbers.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const rev = searchParams.get("rev");
  // Renames send both names so git's rename detection still has both blobs.
  const paths = searchParams.getAll("path").filter(Boolean);
  const filePath = paths[paths.length - 1] ?? null;

  if (!repoPath || !rev || !filePath) {
    return NextResponse.json<ApiError>(
      {
        error: "`repo`, `rev` and `path` are all required.",
        kind: "missing-path",
      },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath);

    let patch: string;
    if (rev === WORKING_REV) {
      const working = await getWorkingTree(repo);
      patch = await getWorkingPatch(repo.root, working.untrackedPaths, {
        context: FULL_CONTEXT,
        pathspec: paths,
      });
    } else if (rev === BRANCH_REV) {
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
      patch = await getRangePatch(repo.root, info.baseSha, "HEAD", {
        context: FULL_CONTEXT,
        pathspec: paths,
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
        { context: FULL_CONTEXT, pathspec: paths },
      );
    }

    const files = parseUnifiedDiff(patch, { maxLinesPerFile: MAX_FILE_LINES });

    // A rename means the file can match under either name.
    const wanted = new Set(paths);
    const file =
      files.find(
        (f) =>
          (f.newPath && wanted.has(f.newPath)) ||
          (f.oldPath && wanted.has(f.oldPath)),
      ) ?? files[0];

    if (!file) {
      return NextResponse.json<ApiError>(
        { error: `${filePath} isn't part of this change.`, kind: "git" },
        { status: 404 },
      );
    }

    const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    const highlighted = await highlightFiles(
      [file],
      MAX_HIGHLIGHT_LINES_SINGLE_FILE,
    );

    const body: FileViewResponse = {
      rev,
      path: filePath,
      file,
      lineCount,
      highlightSkipped: !highlighted,
    };

    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
