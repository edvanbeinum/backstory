import path from "node:path";

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { changeNotes } from "@/lib/notes";
import {
  ack,
  cancel,
  CLIPBOARD,
  DIFFER_REVIEW,
  formatTaken,
  getOutbox,
  isSessionId,
  MAX_MESSAGE,
  queueRound,
  requeue,
  retarget,
  revert,
  take,
} from "@/lib/outbox";
import { answerReview, waitingReview } from "@/lib/review";
import { KEY } from "@/lib/store";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

const bad = (error: string, status = 400) =>
  NextResponse.json<ApiError>({ error }, { status });

/**
 * The worktree root, as the session reported it — a store key, so no
 * `resolveRepo`, as with /api/notes. Only the hook's `cwd` is resolved: it can
 * be anywhere inside the checkout.
 */
function rootParam(searchParams: URLSearchParams): string | null {
  const root = searchParams.get("repo");
  return root && path.isAbsolute(root) ? root : null;
}

/**
 * Sent rounds on their way to an agent.
 *
 *   GET    ?repo=<root>                  — the window: rounds and last-seen session
 *   POST   ?repo=<root> {noteIds, message, at, via?}
 *                                        — the window's Send (or Copy, via "clipboard")
 *   POST   ?take&cwd=<dir>&session=<id>  — the Stop hook: collect what's for it
 *   POST   ?ack&cwd=<dir>&session=<id> {ids}
 *                                        — the Stop hook: it printed them
 *   PATCH  ?repo=<root>&id=<id> {forSession: null}
 *                                        — hand a waiting round to the next session
 *   DELETE ?repo=<root>&id=<id>          — withdraw it; its notes are drafts again
 *
 * Localhost-only by construction: the server binds 127.0.0.1.
 */
export async function GET(request: Request) {
  const root = rootParam(new URL(request.url).searchParams);
  if (!root) return bad("`repo` must be an absolute path.");
  try {
    return NextResponse.json(await getOutbox(root), NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.has("take")) return takeFor(searchParams);
  if (searchParams.has("ack")) return ackFor(searchParams, request);

  const root = rootParam(searchParams);
  if (!root) return bad("`repo` must be an absolute path.");

  let body: { noteIds?: unknown; message?: unknown; at?: unknown; via?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }
  const { noteIds, message, at, via } = body;
  if (
    !Array.isArray(noteIds) ||
    noteIds.length === 0 ||
    !noteIds.every((id) => typeof id === "string" && KEY.test(id))
  ) {
    return bad("`noteIds` must list the notes being sent.");
  }
  if (typeof message !== "string" || !message.trim()) return bad("`message` is required.");
  if (message.length > MAX_MESSAGE) return bad("That review is too long.");
  if (typeof at !== "number") return bad("`at` is required.");
  if (via !== undefined && via !== CLIPBOARD) return bad("`via` can only be \"clipboard\".");

  try {
    // An agent waiting in `differ review` gets it now, as it always has — but
    // only once the round and its notes are both written, so it never reads a
    // review the window then reports as failed.
    const waiting = via ? null : waitingReview(root);
    const round = await queueRound(root, {
      noteIds: noteIds as string[],
      message,
      at,
      deliveredTo: via ?? (waiting ? DIFFER_REVIEW : undefined),
    });
    const notes = await undoIfFails(
      changeNotes(root, { op: "send", ids: round.noteIds, at }),
      () => revert(root, round.id, null),
    );
    if (waiting && !answerReview(waiting.id, { answer: message })) {
      // It stopped waiting while the writes happened: queue it for the hook.
      return NextResponse.json({ round: await requeue(root, round.id), notes }, NO_STORE);
    }
    return NextResponse.json({ round, notes }, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The outbox and the notes are separate files, so a round's two writes can't
 * be one. When the second fails, undo the first rather than leave a round
 * with drafts, or sent notes with no round.
 */
async function undoIfFails<T>(write: Promise<T>, undo: () => Promise<void>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    await undo().catch(() => {});
    throw err;
  }
}

/**
 * The Stop hook's call. Answers `{message: null}` when there's nothing for
 * this session, so the hook can let the agent stop.
 */
async function takeFor(searchParams: URLSearchParams) {
  const cwd = searchParams.get("cwd");
  const session = searchParams.get("session");
  if (!cwd || !path.isAbsolute(cwd)) return bad("`cwd` must be an absolute path.");
  if (!isSessionId(session)) return bad("`session` must be a session id.");

  try {
    const repo = await resolveRepo(cwd);
    const rounds = await take(repo.root, session);
    return NextResponse.json(
      {
        message: rounds.length > 0 ? formatTaken(rounds) : null,
        rounds: rounds.length,
        ids: rounds.map((r) => r.id),
      },
      NO_STORE,
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** The hook printed what it took, so the agent has it. */
async function ackFor(searchParams: URLSearchParams, request: Request) {
  const cwd = searchParams.get("cwd");
  const session = searchParams.get("session");
  if (!cwd || !path.isAbsolute(cwd)) return bad("`cwd` must be an absolute path.");
  if (!isSessionId(session)) return bad("`session` must be a session id.");

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }
  const { ids } = body;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return bad("`ids` must list the rounds taken.");
  }

  try {
    const repo = await resolveRepo(cwd);
    return NextResponse.json({ delivered: await ack(repo.root, session, ids) }, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  const { searchParams } = new URL(request.url);
  const root = rootParam(searchParams);
  const id = searchParams.get("id");
  if (!root || !id) return bad("`repo` and `id` are required.");

  let body: { forSession?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }
  // Only "whoever stops next": aiming at a named session is Send's job.
  if (body.forSession !== null) return bad("`forSession` can only be null.");

  try {
    const round = await retarget(root, id, null);
    if (!round) return bad("That round has already been delivered or withdrawn.", 410);
    return NextResponse.json({ round }, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const root = rootParam(searchParams);
  const id = searchParams.get("id");
  if (!root || !id) return bad("`repo` and `id` are required.");

  try {
    const round = await cancel(root, id);
    if (!round) return bad("That round has already been delivered or withdrawn.", 410);
    const notes = await undoIfFails(
      changeNotes(root, { op: "unsend", ids: round.noteIds }),
      () => revert(root, id, round),
    );
    return NextResponse.json({ notes }, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}
