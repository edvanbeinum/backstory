import path from "node:path";

import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { changeNotes, getNotes, parseChange } from "@/lib/notes";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The worktree root, as the session reported it. Taken from the client
 * without a `resolveRepo`, for the same reason /api/responses takes its key:
 * a note save shouldn't cost five git calls. It's only ever a store key.
 */
function rootParam(request: Request): string | null {
  const root = new URL(request.url).searchParams.get("repo");
  return root && path.isAbsolute(root) ? root : null;
}

const noRoot = () =>
  NextResponse.json<ApiError>(
    { error: "`repo` must be an absolute path.", kind: "missing-path" },
    { status: 400 },
  );

export async function GET(request: Request) {
  const root = rootParam(request);
  if (!root) return noRoot();
  try {
    return NextResponse.json(
      { notes: await getNotes(root) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** Body: one `NotesChange` — `{op: "save", note}`, `{op: "tick", id, done}`, … */
export async function POST(request: Request) {
  const refused = crossSite(request);
  if (refused) return refused;
  const root = rootParam(request);
  if (!root) return noRoot();

  try {
    const change = parseChange(await request.json());
    return NextResponse.json(
      { notes: await changeNotes(root, change) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid")) {
      return NextResponse.json<ApiError>(
        { error: err.message },
        { status: 400 },
      );
    }
    return errorResponse(err);
  }
}
