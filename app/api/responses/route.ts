import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { getPatchId, resolveRepo, resolveRev } from "@/lib/git";
import {
  getResponses,
  updateResponses,
  type ResponsePatch,
} from "@/lib/responses";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `owner/repo#42`. Taken from the client rather than derived from a path,
 * which is the whole point of this route's shape — see below.
 */
const PR_KEY = /^[\w.-]+\/[\w.-]+#\d+$/;

function badKey(key: string | null): key is null {
  return !key || !PR_KEY.test(key);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (badKey(key)) {
    return NextResponse.json<ApiError>(
      { error: "`key` must look like owner/repo#42." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      { responses: await getResponses(key) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Record part of a response:
 *   `{threadId, done}`   — the tick. The only thing that means handled.
 *   `{threadId, reply}`  — the draft; "" or null clears it
 *   `{threadId, sha}`    — link a commit; null unlinks
 *   `{threadId, clear}`  — forget the comment entirely
 *
 * Fields are independent: sending one leaves the others alone, so the
 * debounced draft save and a tick arriving together can't overwrite each
 * other's work.
 *
 * The PR key comes from the client because deriving it here used to cost a
 * `resolveRepo` (about five git calls) plus a GitHub lookup on *every* write,
 * including every 600ms keystroke-burst save — and it meant drafts were
 * silently dropped whenever GitHub was unreachable. Ticking and drafting now
 * cost no subprocesses at all and keep working offline. `repo` is only needed
 * when linking a commit, to compute its patch-id.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (badKey(key)) {
    return NextResponse.json<ApiError>(
      { error: "`key` must look like owner/repo#42." },
      { status: 400 },
    );
  }

  try {
    const body = (await request.json()) as {
      threadId?: string;
      done?: boolean;
      reply?: string | null;
      sha?: string | null;
      clear?: boolean;
    };

    if (typeof body.threadId !== "string") {
      return NextResponse.json<ApiError>(
        { error: "`threadId` is required." },
        { status: 400 },
      );
    }

    if (body.clear) {
      const responses = await updateResponses(key, { [body.threadId]: null });
      return NextResponse.json(
        { responses },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const patch: ResponsePatch = {};
    if (typeof body.done === "boolean") patch.done = body.done;
    if (body.reply !== undefined) patch.reply = body.reply;

    if (body.sha !== undefined) {
      if (body.sha === null) {
        patch.commit = null;
      } else {
        // Store the patch-id beside the sha: a rebase rewrites the sha but
        // not the patch-id, which is how the link survives one.
        const repoPath = searchParams.get("repo");
        if (!repoPath) {
          return NextResponse.json<ApiError>(
            { error: "`repo` is required to link a commit." },
            { status: 400 },
          );
        }
        const repo = await resolveRepo(repoPath);
        // Expand whatever was given — a pasted short sha, or a ref — to the
        // full one. Storing an abbreviation would compare unequal against
        // every full sha in the UI, and would stop being unique as the repo
        // grows. Not resolving is also how a typo gets caught, here, rather
        // than as a link that silently points at nothing.
        const sha = await resolveRev(repo.root, body.sha);
        if (!sha) {
          return NextResponse.json<ApiError>(
            { error: `No commit ${body.sha} in this repository.` },
            { status: 400 },
          );
        }
        patch.commit = { sha, patchId: await getPatchId(repo.root, sha) };
      }
    }

    const responses = await updateResponses(key, { [body.threadId]: patch });
    return NextResponse.json(
      { responses },
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
