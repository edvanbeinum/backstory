import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { browse } from "@/lib/browse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Directory listing for the repo picker, plus the sibling worktrees of the
 * repo you're currently on. Read-only and names-only: no file contents ever
 * leave here, and the server is bound to 127.0.0.1.
 *
 * `path` — directory to list; defaults to $HOME.
 * `repo` — the open checkout, used to find its sibling worktrees.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dir = searchParams.get("path") ?? "";
  const repo = searchParams.get("repo");

  try {
    const result = await browse(dir, repo);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
