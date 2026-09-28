import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * Review requests: an agent (via `differ review`) waiting for your notes.
 *
 * The CLI opens a request and long-polls it; the window sees one is waiting
 * and offers "Send to agent"; sending answers it, and the CLI prints the
 * answer and exits — which is what hands it back to the agent session.
 *
 * In memory on purpose, like the CLI's repo handoff: a request is only
 * meaningful while both the waiting process and this server are alive. Kept
 * on globalThis because Next may load this module once per route bundle, and
 * the route that opens a request and the one that answers it must share it.
 */

export type ReviewState = "waiting" | "answered" | "dismissed" | "superseded";

export interface ReviewRequest {
  id: string;
  root: string;
  createdAt: number;
  /** Last time the CLI asked; a request nobody is polling is abandoned */
  lastPollAt: number;
  state: ReviewState;
  answer: string | null;
}

/** Longer than one long-poll, so a poller between requests isn't reaped. */
const ABANDONED_MS = 60_000;

interface Registry {
  requests: Map<string, ReviewRequest>;
  events: EventEmitter;
}

const g = globalThis as { __differReviews?: Registry };
const registry: Registry = (g.__differReviews ??= {
  requests: new Map(),
  events: new EventEmitter().setMaxListeners(0),
});

function changed(root: string) {
  registry.events.emit("change", root);
}

function settle(request: ReviewRequest, state: ReviewState, answer: string | null) {
  request.state = state;
  request.answer = answer;
  registry.events.emit(`settled:${request.id}`);
  changed(request.root);
}

/**
 * Drop requests nobody has polled for a while: a waiting one's CLI has gone
 * away, and a settled one's answer has had every chance to be collected.
 */
function prune() {
  const now = Date.now();
  for (const [id, request] of registry.requests) {
    if (now - request.lastPollAt <= ABANDONED_MS) continue;
    registry.requests.delete(id);
    if (request.state === "waiting") changed(request.root);
  }
}

/**
 * Start waiting for a review of `root`. One at a time per checkout: a second
 * request replaces the first, whose CLI is told so and exits — otherwise two
 * agents would race for the same notes.
 */
export function openReview(root: string): ReviewRequest {
  prune();
  for (const request of registry.requests.values()) {
    if (request.root === root && request.state === "waiting") {
      settle(request, "superseded", null);
    }
  }
  const now = Date.now();
  const request: ReviewRequest = {
    id: randomUUID(),
    root,
    createdAt: now,
    lastPollAt: now,
    state: "waiting",
    answer: null,
  };
  registry.requests.set(request.id, request);
  changed(root);
  return request;
}

export function getReview(id: string): ReviewRequest | null {
  prune();
  return registry.requests.get(id) ?? null;
}

/** The request waiting on this checkout, if any. */
export function waitingReview(root: string): ReviewRequest | null {
  prune();
  for (const request of registry.requests.values()) {
    if (request.root === root && request.state === "waiting") return request;
  }
  return null;
}

/**
 * Wait up to `ms` for a request to settle. Returns it either way; still
 * "waiting" means ask again. Counts as a poll, which keeps it alive.
 */
export function awaitReview(
  id: string,
  ms: number,
  signal?: AbortSignal,
): Promise<ReviewRequest | null> {
  const request = getReview(id);
  if (!request) return Promise.resolve(null);
  request.lastPollAt = Date.now();
  if (request.state !== "waiting") return Promise.resolve(request);

  return new Promise((resolve) => {
    const event = `settled:${id}`;
    const done = () => {
      clearTimeout(timer);
      registry.events.off(event, done);
      signal?.removeEventListener("abort", done);
      request.lastPollAt = Date.now();
      resolve(request);
    };
    const timer = setTimeout(done, ms);
    registry.events.on(event, done);
    signal?.addEventListener("abort", done);
  });
}

/** Settle a waiting request. False if it isn't waiting any more. */
export function answerReview(
  id: string,
  outcome: { answer: string } | { dismiss: true },
): boolean {
  const request = getReview(id);
  if (!request || request.state !== "waiting") return false;
  if ("answer" in outcome) settle(request, "answered", outcome.answer);
  else settle(request, "dismissed", null);
  return true;
}

/** The CLI gave up (Ctrl-C, killed): forget it now rather than at timeout. */
export function cancelReview(id: string): void {
  const request = registry.requests.get(id);
  if (!request) return;
  registry.requests.delete(id);
  if (request.state === "waiting") changed(request.root);
}

/** Be told when a checkout's waiting request appears or goes away. */
export function onReviewChange(listener: (root: string) => void): () => void {
  registry.events.on("change", listener);
  return () => registry.events.off("change", listener);
}
