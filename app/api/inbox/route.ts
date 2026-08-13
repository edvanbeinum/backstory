import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { expandPath } from "@/lib/git";
import { buildInbox } from "@/lib/inbox";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/inbox?root=/a&root=/b&fresh=1`
 *
 * The roots come from the client, which remembers the repos you've opened.
 * A repo that fails — no remote, `gh` missing, GitHub unreachable — comes back
 * with an `unavailable` note and its worktrees intact, because the inbox is a
 * list of your checkouts and GitHub only decorates it. The only 400 is asking
 * for nothing at all: a home screen you can 500 out of is one you can't get
 * back into.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Expanded here so a hand-typed "~/code/thing" resolves, the same as
  // every other path differ accepts.
  const roots = searchParams.getAll("root").filter(Boolean).map(expandPath);
  const fresh = searchParams.get("fresh") === "1";

  if (roots.length === 0) {
    return NextResponse.json<ApiError>(
      { error: "No repositories to scan.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await buildInbox(roots, { fresh }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
