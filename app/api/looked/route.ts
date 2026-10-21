import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { gitLine } from "@/lib/exec";
import { gitCommonDir, resolveRepo } from "@/lib/git";
import { markLooked } from "@/lib/looked";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error: string) =>
  NextResponse.json<ApiError>({ error }, { status: 400 });

/**
 * `POST /api/looked?repo=<path>&ref=<branch>&tip=<sha>`: you opened this
 * branch, so the inbox reads it as seen until it gets another commit. The page
 * sends it on every load of a branch but a background refresh, which would
 * otherwise mark commits seen that arrived while you weren't looking. It sends
 * the tip it showed you, because a commit can land while the page waits on
 * GitHub; without one, the branch's tip now is stored.
 */
export async function POST(request: Request) {
  const refused = crossSite(request);
  if (refused) return refused;
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const ref = searchParams.get("ref");
  const shown = searchParams.get("tip") || null;
  if (!repoPath || !ref) return bad("`repo` and `ref` are required.");
  if (shown && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(shown)) {
    return bad("`tip` must be a full commit SHA.");
  }

  try {
    const repo = await resolveRepo(repoPath);
    const [commonDir, tip] = await Promise.all([
      gitCommonDir(repo.root),
      // Read the tip with show-ref, which takes only an exact ref, so
      // `main~1` or `main@{1}` is refused, not stored under a name nothing reads.
      gitLine(repo.root, [
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${ref}`,
      ]),
    ]);
    if (!tip) return bad(`No local branch named ${ref}.`);
    markLooked(commonDir, ref, shown ?? tip);
    return NextResponse.json({ tip: shown ?? tip });
  } catch (err) {
    return errorResponse(err);
  }
}
