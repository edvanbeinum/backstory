import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  cancel,
  CLIPBOARD,
  formatTaken,
  getOutbox,
  onOutboxChange,
  queueRound,
  retarget,
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

  const [first, second] = await Promise.all([take(ROOT, "s-a"), take(ROOT, "s-b")]);
  assert.equal(first.length + second.length, 1);

  const { rounds } = await getOutbox(ROOT);
  assert.equal(rounds[0].deliveredTo, first.length ? "s-a" : "s-b");
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
  assert.deepEqual(taken.map((r) => r.id), [queued.id]);
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

test("a copied round is recorded as delivered and never taken", async () => {
  useTempHome();
  const copied = await queueRound(ROOT, { ...round(["n1"]), deliveredTo: CLIPBOARD });
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
