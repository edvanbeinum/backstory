import path from "node:path";

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { changeNotes, getNotes, type NotesChange } from "@/lib/notes";
import type { ApiError, Note } from "@/lib/types";

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

/**
 *   `{save: Note}`   — add or edit one
 *   `{remove: id}`   — delete one
 *   `{clear: true}`  — delete them all, e.g. once they've been sent
 */
export async function POST(request: Request) {
  const root = rootParam(request);
  if (!root) return noRoot();

  try {
    const body = (await request.json()) as {
      save?: Note;
      remove?: string;
      clear?: boolean;
    };

    let change: NotesChange;
    if (body.save) change = { save: body.save };
    else if (typeof body.remove === "string") change = { remove: body.remove };
    else if (body.clear === true) change = { clear: true };
    else {
      return NextResponse.json<ApiError>(
        { error: "Send one of `save`, `remove` or `clear`." },
        { status: 400 },
      );
    }

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
