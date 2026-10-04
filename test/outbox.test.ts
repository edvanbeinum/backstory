import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ack,
  cancel,
  CLAIM_MS,
  CLIPBOARD,
  DIFFER_REVIEW,
  formatTaken,
  getOutbox,
  onOutboxChange,
  queueRound,
  requeue,
  retarget,
  revert,
  take,
} from "../lib/outbox";

/** The store resolves DIFFER_HOME per call; never touch the real ~/.differ. */
function useTempHome(): void {
  process.env.DIFFER_HOME = mkdtempSync(path.join(tmpdir(), "differ-outbox-"));
}

const ROOT = "/repos/app";
const round = (noteIds: string[], message = "fix it", at = Date.now()) => ({
  noteIds,
  message,
  at,
});

test("with no session seen, the first to stop takes the round, and only once", async () => {
  useTempHome();
  const queued = await queueRound(ROOT, round(["n1"]));
  assert.equal(queued.forSession, null);

  const [first, second] = await Promise.all([
    take(ROOT, "s-a"),
    take(ROOT, "s-b"),
  ]);
  assert.equal(first.length + second.length, 1);
  const winner = first.length ? "s-a" : "s-b";
  assert.equal(await ack(ROOT, winner, [queued.id]), 1);

  const { rounds } = await getOutbox(ROOT);
  assert.equal(rounds[0].deliveredTo, winner);
  assert.notEqual(rounds[0].deliveredAt, null);
});

test("send aims at the session last seen stopping here", async () => {
  useTempHome();
  assert.deepEqual(await take(ROOT, "s-old"), []);
  assert.deepEqual(await take(ROOT, "s-mine"), []);
  const queued = await queueRound(ROOT, round(["n1"]));
  assert.equal(queued.forSession, "s-mine");
  assert.equal((await getOutbox(ROOT)).lastSeen?.session, "s-mine");

  // Another session stopping here doesn't get it.
  assert.deepEqual(await take(ROOT, "s-old"), []);
  const taken = await take(ROOT, "s-mine");
  assert.deepEqual(
    taken.map((r) => r.id),
    [queued.id],
  );
  await ack(ROOT, "s-mine", [queued.id]);
  // And the next stop finds nothing — the hook doesn't loop.
  assert.deepEqual(await take(ROOT, "s-mine"), []);
});

test("sessions in other checkouts don't count as seen here", async () => {
  useTempHome();
  await take("/repos/other", "s-elsewhere");
  assert.equal((await queueRound(ROOT, round(["n1"]))).forSession, null);
});

test("a queued round survives a restart", async () => {
  useTempHome();
  await take(ROOT, "s-1");
  const queued = await queueRound(ROOT, round(["n1", "n2"], "the notes"));
  // Nothing is held in memory: a fresh read of the file is all a new server has.
  const { rounds, lastSeen } = await getOutbox(ROOT);
  assert.equal(lastSeen?.session, "s-1");
  assert.deepEqual(rounds, [queued]);
  assert.equal((await take(ROOT, "s-1"))[0].message, "the notes");
});

test("retarget hands a waiting round to whichever session stops next", async () => {
  useTempHome();
  await take(ROOT, "s-ended");
  const queued = await queueRound(ROOT, round(["n1"]));
  assert.deepEqual(await take(ROOT, "s-new"), []);

  assert.equal((await retarget(ROOT, queued.id, null))?.forSession, null);
  assert.equal((await take(ROOT, "s-new")).length, 1);
  await ack(ROOT, "s-new", [queued.id]);
  // Delivered rounds can't be re-aimed or withdrawn.
  assert.equal(await retarget(ROOT, queued.id, null), null);
  assert.equal(await cancel(ROOT, queued.id), null);
});

test("cancel withdraws a waiting round, so nothing is delivered", async () => {
  useTempHome();
  const queued = await queueRound(ROOT, round(["n1", "n2"]));
  const withdrawn = await cancel(ROOT, queued.id);
  assert.deepEqual(withdrawn?.noteIds, ["n1", "n2"]);
  assert.deepEqual(await take(ROOT, "s-any"), []);
  assert.deepEqual((await getOutbox(ROOT)).rounds, []);
});

test("a take that's never confirmed leaves the round to be taken again", async () => {
  useTempHome();
  const queued = await queueRound(ROOT, round(["n1"]));
  assert.equal((await take(ROOT, "s-a")).length, 1);
  assert.equal((await getOutbox(ROOT)).rounds[0].deliveredAt, null);

  // Claimed: no other session gets it, and it can't be withdrawn under the agent.
  assert.deepEqual(await take(ROOT, "s-b"), []);
  assert.equal(await cancel(ROOT, queued.id), null);
  // The same session's next stop does — its last hook may never have printed it.
  assert.equal((await take(ROOT, "s-a")).length, 1);
  // Only the holder can confirm it.
  assert.equal(await ack(ROOT, "s-b", [queued.id]), 0);

  const realNow = Date.now;
  Date.now = () => realNow() + CLAIM_MS + 1;
  try {
    assert.equal((await take(ROOT, "s-b")).length, 1);
    assert.equal(await ack(ROOT, "s-b", [queued.id]), 1);
  } finally {
    Date.now = realNow;
  }
  assert.equal((await getOutbox(ROOT)).rounds[0].deliveredTo, "s-b");
});

test("revert undoes a filing or a withdrawal exactly", async () => {
  useTempHome();
  const filed = await queueRound(ROOT, round(["n1"]));
  await revert(ROOT, filed.id, null);
  assert.deepEqual((await getOutbox(ROOT)).rounds, []);

  const queued = await queueRound(ROOT, round(["n2"]));
  const withdrawn = await cancel(ROOT, queued.id);
  await revert(ROOT, queued.id, withdrawn);
  assert.deepEqual((await getOutbox(ROOT)).rounds, [queued]);
});

test("requeue turns a round filed as answered back into a queued one", async () => {
  useTempHome();
  await take(ROOT, "s-1");
  const answered = await queueRound(ROOT, {
    ...round(["n1"]),
    deliveredTo: DIFFER_REVIEW,
  });
  const queued = await requeue(ROOT, answered.id);
  assert.equal(queued?.deliveredAt, null);
  assert.equal(queued?.forSession, "s-1");
  assert.equal((await take(ROOT, "s-1")).length, 1);
});

test("a copied round is recorded as delivered and never taken", async () => {
  useTempHome();
  const copied = await queueRound(ROOT, {
    ...round(["n1"]),
    deliveredTo: CLIPBOARD,
  });
  assert.equal(copied.deliveredTo, CLIPBOARD);
  assert.notEqual(copied.deliveredAt, null);
  assert.deepEqual(await take(ROOT, "s-any"), []);
});

test("several rounds are taken together, oldest first", async () => {
  useTempHome();
  await queueRound(ROOT, round(["n2"], "second", 2));
  await queueRound(ROOT, round(["n1"], "first", 1));
  const text = formatTaken(await take(ROOT, "s-1"));
  assert.ok(text.indexOf("first") < text.indexOf("second"));
});

test("every write tells the watch stream", async () => {
  useTempHome();
  const seen: string[] = [];
  const stop = onOutboxChange((root) => seen.push(root));
  const queued = await queueRound(ROOT, round(["n1"]));
  await take(ROOT, "s-1");
  await cancel(ROOT, queued.id); // already delivered: no change, no event
  stop();
  assert.deepEqual(seen, [ROOT, ROOT]);
});

test("bad ids are refused", async () => {
  useTempHome();
  assert.throws(() => take(ROOT, "not a session"), /Invalid session/);
  assert.throws(() => queueRound(ROOT, round(["../x"])), /Invalid note/);
});
