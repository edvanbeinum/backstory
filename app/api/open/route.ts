import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { setPendingRepo, takePendingRepo } from "@/lib/pending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CLI ↔ app-window handoff.
 *
 * `GET /api/open?repo=<path>` — called by the `differ` CLI from a checkout.
 * Validates the path is a real repo and parks it for the app window.
 *
 * `GET /api/open` — polled by the app window on load and on focus. Returns
 * the parked repo (clearing it) or `{repo: null}`.
 *
 * Localhost-only by construction: the server binds 127.0.0.1.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");

  if (repoPath === null) {
    return NextResponse.json(
      { repo: takePendingRepo() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // Resolve before parking, so the CLI hears about a bad path immediately
    // and the window never gets handed garbage.
    const repo = await resolveRepo(repoPath);
    setPendingRepo(repo.root);
    return NextResponse.json(
      { ok: true, repo: repo.root },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
