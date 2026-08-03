import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { loadGitHubDataCached } from "@/lib/github";
import { getLinks, prKey, setLink } from "@/lib/links";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolve the repo to its `owner/repo#pr` pin key, or an error response. */
async function keyFor(
  repoPath: string,
): Promise<{ key: string } | { error: string }> {
  const repo = await resolveRepo(repoPath);
  const github = await loadGitHubDataCached(repo);
  if (!github.pr) return { error: "No pull request for this branch." };

  const key = prKey(repo.owner, repo.name, github.pr.number);
  if (!key) return { error: "No GitHub remote." };
  return { key };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "`repo` is required.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const resolved = await keyFor(repoPath);
    if ("error" in resolved) return NextResponse.json({ links: {} });
    return NextResponse.json(
      { links: await getLinks(resolved.key) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** Pin `{threadId, sha}`; a null sha unpins. Returns the PR's full pin map. */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "`repo` is required.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const body = (await request.json()) as {
      threadId?: string;
      sha?: string | null;
    };
    if (typeof body.threadId !== "string") {
      return NextResponse.json<ApiError>(
        { error: "`threadId` is required." },
        { status: 400 },
      );
    }

    const resolved = await keyFor(repoPath);
    if ("error" in resolved) {
      return NextResponse.json<ApiError>(
        { error: resolved.error },
        { status: 400 },
      );
    }

    const links = await setLink(
      resolved.key,
      body.threadId,
      body.sha ?? null,
    );
    return NextResponse.json(
      { links },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid")) {
      return NextResponse.json<ApiError>({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
