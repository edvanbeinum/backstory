import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { fetchBranch } from "@/lib/fetch";
import { resolveRepo } from "@/lib/git";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{repo, branch, base?}`: fetches `branch` from origin into a local branch. */
export async function POST(request: Request) {
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const body = (await request.json()) as {
      repo?: unknown;
      branch?: unknown;
      base?: unknown;
    };
    if (typeof body.repo !== "string" || typeof body.branch !== "string") {
      return NextResponse.json<ApiError>(
        { error: "`repo` and `branch` are required." },
        { status: 400 },
      );
    }
    const repo = await resolveRepo(body.repo);
    const base = typeof body.base === "string" ? body.base : null;
    return NextResponse.json(await fetchBranch(repo.root, body.branch, base), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
