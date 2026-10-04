import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { snippet } from "@/lib/snippet";
import type { ApiError } from "@/lib/types";
import { viewRange } from "@/lib/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The lines around one line of a view: a flow step's inline code. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const rev = searchParams.get("rev");
  const path = searchParams.get("path");
  const line = Number(searchParams.get("line"));
  const side = searchParams.get("side") === "old" ? "old" : "new";
  if (!repoPath || !rev || !path || !line) {
    return NextResponse.json<ApiError>(
      {
        error: "`repo`, `rev`, `path` and `line` are required.",
        kind: "missing-path",
      },
      { status: 400 },
    );
  }
  try {
    const repo = await resolveRepo(repoPath);
    const range = await viewRange(repo, rev);
    if (!range) {
      return NextResponse.json<ApiError>(
        { error: "No commit to read from.", kind: "git" },
        { status: 404 },
      );
    }
    const found = await snippet({
      root: repo.root,
      ...range,
      path,
      side,
      line,
    });
    if (!found) {
      return NextResponse.json<ApiError>(
        { error: `${path}:${line} isn't there.`, kind: "git" },
        { status: 404 },
      );
    }
    return NextResponse.json(found);
  } catch (err) {
    return errorResponse(err);
  }
}
