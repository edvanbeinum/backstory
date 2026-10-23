import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { descriptionStatus, startDescription } from "@/lib/description/cache";
import type { DescriptionResponse } from "@/lib/description/types";
import { resolveRepo } from "@/lib/git";
import { loadGitHubDataCached } from "@/lib/github";
import type { ApiError } from "@/lib/types";
import { onBranchOnly, viewRange } from "@/lib/view";

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
  const repo = await resolveRepo(repoPath, searchParams.get("ref"));
  const range = await viewRange(repo, rev);
  return { repo, range, searchParams };
}

const answer = (body: DescriptionResponse) =>
  NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

/** The view's change description, or how its read is going. */
export async function GET(request: Request) {
  try {
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range) return answer({ status: "none" });
    return answer(await descriptionStatus({ root: r.repo.root, ...r.range }));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Starts reading the view's change description; `redraft=1` reads it again. */
export async function POST(request: Request) {
  // Refuse requests from other sites, since a read sends code to the AI
  // provider.
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const r = await resolve(request);
    if (r.error) return r.error;
    if (!r.range)
      return NextResponse.json<ApiError>(
        { error: "There's no commit here to describe.", kind: "internal" },
        { status: 409 },
      );
    const repo = r.repo;
    const head = r.range.head;
    return answer(
      await startDescription(
        { root: repo.root, ...r.range },
        {
          redraft: r.searchParams.get("redraft") === "1",
          pr: async () => {
            const { pr } = await loadGitHubDataCached(repo);
            if (!pr || !(await onBranchOnly(repo, head))) return null;
            return { title: pr.title, body: pr.body };
          },
        },
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
