import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { flowsStatus, startFlows, startTrace } from "@/lib/flows/cache";
import type { FlowsStatus } from "@/lib/flows/types";
import { resolveRepo } from "@/lib/git";
import type { ApiError } from "@/lib/types";
import { viewRange } from "@/lib/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Flows for a view. GET reads (cached flows, a run in progress, or nothing
 * yet); POST starts a run, regenerates, or traces one more flow for a hunk.
 * A finished run is announced on /api/watch as a "flows" event.
 */

async function resolve(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const rev = searchParams.get("rev");
  if (!repoPath || !rev) {
    return {
      error: NextResponse.json<ApiError>(
        { error: "Both `repo` and `rev` are required.", kind: "missing-path" },
        { status: 400 },
      ),
    };
  }
  const repo = await resolveRepo(repoPath, searchParams.get("ref"));
  const range = await viewRange(repo, rev);
  return { repo, range, searchParams };
}

const uncommitted: FlowsStatus = {
  status: "unavailable",
  reason: "uncommitted",
};

export async function GET(request: Request) {
  try {
    const r = await resolve(request);
    if ("error" in r) return r.error;
    if (!r.range) return NextResponse.json(uncommitted);
    return NextResponse.json(
      await flowsStatus({ root: r.repo.root, ...r.range }),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  // A read sends code to the AI provider: only Backstory's own page asks.
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const r = await resolve(request);
    if ("error" in r) return r.error;
    if (!r.range) return NextResponse.json(uncommitted);
    const view = { root: r.repo.root, ...r.range };
    const hunk = r.searchParams.get("hunk");
    const status = hunk
      ? await startTrace(view, hunk)
      : await startFlows(view, {
          regenerate: r.searchParams.get("regenerate") === "1",
        });
    return NextResponse.json(status);
  } catch (err) {
    return errorResponse(err);
  }
}
