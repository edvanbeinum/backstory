import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import {
  answerReview,
  awaitReview,
  cancelReview,
  openReview,
  waitingReview,
} from "@/lib/review";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Under common proxy and fetch idle limits; the CLI just asks again. */
const LONG_POLL_MS = 25_000;

/** Long enough for any real review; a guard against a runaway writer. */
const MAX_ANSWER = 200_000;

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

const bad = (error: string, status = 400) =>
  NextResponse.json<ApiError>({ error }, { status });

/**
 * The `backstory review` ↔ window handoff.
 *
 *   GET  ?repo=<root>       — the window: is an agent waiting on this checkout?
 *   GET  ?id=<id>           — the CLI: long-poll until the request settles
 *   POST ?repo=<path>       — the CLI: start waiting for a review
 *   POST ?id=<id> {answer}  — the window: send the notes
 *   POST ?id=<id> {dismiss} — the window: let the agent go without notes
 *   DELETE ?id=<id>         — the CLI: stopped waiting
 *
 * Localhost-only by construction: the server binds 127.0.0.1.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const root = searchParams.get("repo");

  if (id) {
    const review = await awaitReview(id, LONG_POLL_MS, request.signal);
    if (!review)
      return bad("No such review request — it may have expired.", 404);
    return NextResponse.json(
      { state: review.state, answer: review.answer },
      NO_STORE,
    );
  }

  if (root) {
    const review = waitingReview(root);
    return NextResponse.json(
      {
        waiting: review ? { id: review.id, createdAt: review.createdAt } : null,
      },
      NO_STORE,
    );
  }

  return bad("Send `id` or `repo`.");
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const repoPath = searchParams.get("repo");

  if (repoPath) {
    try {
      const repo = await resolveRepo(repoPath);
      const review = openReview(repo.root);
      return NextResponse.json({ id: review.id, repo: repo.root }, NO_STORE);
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (!id) return bad("Send `id` or `repo`.");

  let body: { answer?: unknown; dismiss?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Expected a JSON body.");
  }

  let settled: boolean;
  if (typeof body.answer === "string" && body.answer.trim()) {
    if (body.answer.length > MAX_ANSWER) return bad("That review is too long.");
    settled = answerReview(id, { answer: body.answer });
  } else if (body.dismiss === true) {
    settled = answerReview(id, { dismiss: true });
  } else {
    return bad("Send `answer` or `dismiss`.");
  }

  // Gone means the agent stopped waiting — the window keeps your notes.
  if (!settled)
    return bad("The agent isn't waiting for this review any more.", 410);
  return NextResponse.json({ ok: true }, NO_STORE);
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return bad("`id` is required.");
  cancelReview(id);
  return NextResponse.json({ ok: true }, NO_STORE);
}
