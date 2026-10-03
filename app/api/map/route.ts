import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { buildMap } from "@/lib/map";
import type { ApiError } from "@/lib/types";
import { viewRange } from "@/lib/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The system map for a view: what the change touched in the C4 model. */
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
    const range = await viewRange(repo, rev);
    if (!range) return NextResponse.json({ status: "none" });
    return NextResponse.json(await buildMap(repo.root, range.base, range.head), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
