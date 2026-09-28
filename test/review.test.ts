import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answerReview,
  awaitReview,
  cancelReview,
  onReviewChange,
  openReview,
  waitingReview,
} from "../lib/review";

test("an answer wakes the waiting poll and is only given once", async () => {
  const request = openReview("/repo/send");
  assert.equal(waitingReview("/repo/send")?.id, request.id);

  const poll = awaitReview(request.id, 5_000);
  assert.equal(answerReview(request.id, { answer: "fix it" }), true);

  const settled = await poll;
  assert.equal(settled?.state, "answered");
  assert.equal(settled?.answer, "fix it");
  assert.equal(waitingReview("/repo/send"), null);
  assert.equal(answerReview(request.id, { answer: "again" }), false);
});

test("a poll that times out is still waiting", async () => {
  const request = openReview("/repo/timeout");
  assert.equal((await awaitReview(request.id, 10))?.state, "waiting");
  cancelReview(request.id);
});

test("a second request for a checkout supersedes the first", async () => {
  const first = openReview("/repo/twice");
  const second = openReview("/repo/twice");
  assert.equal((await awaitReview(first.id, 10))?.state, "superseded");
  assert.equal(waitingReview("/repo/twice")?.id, second.id);
  cancelReview(second.id);
});

test("cancelling forgets the request and tells the window", () => {
  const seen: string[] = [];
  const stop = onReviewChange((root) => seen.push(root));
  const request = openReview("/repo/cancel");
  cancelReview(request.id);
  stop();

  assert.equal(waitingReview("/repo/cancel"), null);
  assert.deepEqual(seen, ["/repo/cancel", "/repo/cancel"]);
  assert.equal(answerReview(request.id, { dismiss: true }), false);
});
