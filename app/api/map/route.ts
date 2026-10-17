import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { autoRead } from "@/lib/data/cache";
import { resolveRepo } from "@/lib/git";
import { buildMap } from "@/lib/map";
import { startMapRead, startMapTrunkRead } from "@/lib/models/cache";
import type { ApiError } from "@/lib/types";
import { viewRange } from "@/lib/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const repo = await resolveRepo(repoPath);
  const range = await viewRange(repo, rev);
  return { root: repo.root, range, searchParams };
}

/** The system map for a view: what the change touched in the C4 model. */
export async function GET(request: Request) {
  try {
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range) return NextResponse.json({ status: "none" });
    return NextResponse.json(
      await buildMap(r.root, r.range.base, r.range.head),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Starts the AI provider's read of the view's map; `redraft=1` reads main's
 * map and the view's again. `trunk=1` starts reading main's map for `repo`,
 * when reading automatically is on.
 */
export async function POST(request: Request) {
  // A read costs money and sends code to the AI provider: only Backstory's own page asks.
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("trunk") === "1") {
      const repoPath = searchParams.get("repo");
      if (!repoPath)
        return NextResponse.json<ApiError>(
          { error: "`repo` is required.", kind: "missing-path" },
          { status: 400 },
        );
      const { root } = await resolveRepo(repoPath);
      return NextResponse.json({
        started: autoRead() && (await startMapTrunkRead(root)),
      });
    }
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range)
      return NextResponse.json<ApiError>(
        { error: "There's no commit here to read.", kind: "internal" },
        { status: 409 },
      );
    const { base, head } = r.range;
    const started = await startMapRead(
      { root: r.root, base, head },
      { redraft: r.searchParams.get("redraft") === "1" },
    );
    if (started.status === "refused")
      return NextResponse.json<ApiError>(
        {
          error:
            started.reason === "committed"
              ? "This repo commits its own model, so there's nothing to draft."
              : "This repo has a hand-written local model, so there's nothing to draft.",
          kind: "internal",
        },
        { status: 409 },
      );
    return NextResponse.json(await buildMap(r.root, base, head), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
