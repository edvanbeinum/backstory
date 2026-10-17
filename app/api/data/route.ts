import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { buildData, noDataModel } from "@/lib/data/build";
import {
  autoRead,
  setAutoRead,
  startDataRead,
  startTrunkRead,
} from "@/lib/data/cache";
import { dataSteer, readDataModel, steerError } from "@/lib/data/readers";
import { resolveRepo } from "@/lib/git";
import { readModelAt } from "@/lib/model";
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

/** The data model's change for a view: entities, fields, relationships, constraints. */
export async function GET(request: Request) {
  try {
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range) return NextResponse.json(noDataModel());
    return NextResponse.json(
      await buildData(r.root, r.range.base, r.range.head),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Starts the AI provider's read of the view's data model; `redraft=1` reads it
 * again. `trunk=1` starts reading main's data model for `repo`, when reading
 * automatically is on. `auto=1` and `auto=0` turn reading automatically on
 * and off.
 */
export async function POST(request: Request) {
  // A read sends code to the AI provider: only Backstory's own page asks.
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const { searchParams } = new URL(request.url);
    const auto = searchParams.get("auto");
    if (auto === "1" || auto === "0") {
      setAutoRead(auto === "1");
      return NextResponse.json({ auto: autoRead() });
    }
    if (searchParams.get("trunk") === "1") {
      const repoPath = searchParams.get("repo");
      if (!repoPath)
        return NextResponse.json<ApiError>(
          { error: "`repo` is required.", kind: "missing-path" },
          { status: 400 },
        );
      const { root } = await resolveRepo(repoPath);
      return NextResponse.json({
        started: autoRead() && (await startTrunkRead(root)),
      });
    }
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range)
      return NextResponse.json<ApiError>(
        { error: "There's no commit here to read.", kind: "internal" },
        { status: 409 },
      );
    const view = { root: r.root, base: r.range.base, head: r.range.head };
    const steer = dataSteer(
      (await readModelAt(view.root, view.head))?.model?.properties,
    );
    const error = steerError(steer);
    if (error)
      return NextResponse.json<ApiError>(
        { error, kind: "internal" },
        { status: 409 },
      );
    if (await readDataModel(view.root, view.head, steer))
      return NextResponse.json<ApiError>(
        {
          error: "A data reader reads this repo, so there's nothing to draft.",
          kind: "internal",
        },
        { status: 409 },
      );
    await startDataRead(
      { ...view, files: steer.files },
      {
        redraft: r.searchParams.get("redraft") === "1",
      },
    );
    return NextResponse.json(await buildData(view.root, view.base, view.head), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
