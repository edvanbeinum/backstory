import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getAllResponses,
  getResponses,
  updateResponses,
} from "../lib/responses";
import { db } from "../lib/store";

/**
 * The store resolves `~/.backstory` per call so BACKSTORY_HOME can redirect it;
 * without that these tests would write to the real database, which holds the
 * only copy of your drafts.
 */
function useTempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "backstory-test-"));
  process.env.BACKSTORY_HOME = home;
  return home;
}

const stored = () =>
  (db().prepare("SELECT COUNT(*) AS n FROM responses").get() as { n: number })
    .n;

const SHA_A = "76c66deaa060ae3da0ff460e13aabfff3de885c4";
const PATCH_A = "5265095d7fd0b28d9cb0360ffa675bdc5f5cd38d";
const SHA_B = "822fc14ef375c27445f3472f2d6b093035f27637";
const PATCH_B = "2a5465a29bd69a77c8855480cdc45ab5b6382484";

test("a tick and a draft save on the same record don't clobber each other", async () => {
  useTempHome();

  // The 600ms debounced reply save and the tick land on one record at once.
  await Promise.all([
    updateResponses("o/r#1", { t1: { done: true } }),
    updateResponses("o/r#1", { t1: { reply: "Addressed in abc1234" } }),
    updateResponses("o/r#1", {
      t1: { addCommit: { sha: SHA_A, patchId: PATCH_A } },
    }),
  ]);

  const forPr = await getResponses("o/r#1");
  assert.equal(forPr.t1.done, true, "the tick survived");
  assert.equal(forPr.t1.reply, "Addressed in abc1234", "the draft survived");
  assert.deepEqual(forPr.t1.commits[0] ?? null, {
    sha: SHA_A,
    patchId: PATCH_A,
  });
  assert.equal(stored(), 1);
});

test("concurrent writes to different PRs all land", async () => {
  useTempHome();

  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      updateResponses(`o/r#${i}`, { [`t${i}`]: { done: true } }),
    ),
  );

  const all = await getAllResponses();
  assert.equal(Object.keys(all).length, 12);
});

test("doneAt stamps on the transition and clears on untick", async () => {
  useTempHome();

  await updateResponses("o/r#1", { t1: { done: true } });
  const first = (await getResponses("o/r#1")).t1.doneAt;
  assert.ok(typeof first === "number");

  // Re-ticking an already-ticked comment must not move the timestamp.
  await updateResponses("o/r#1", { t1: { done: true } });
  assert.equal((await getResponses("o/r#1")).t1.doneAt, first);

  await updateResponses("o/r#1", { t1: { done: false, reply: "keep me" } });
  assert.equal((await getResponses("o/r#1")).t1.doneAt, null);
});

test("a record holding nothing is deleted rather than stored empty", async () => {
  useTempHome();

  await updateResponses("o/r#1", { t1: { done: true, reply: "hi" } });
  await updateResponses("o/r#1", { t1: { done: false, reply: null } });

  assert.equal(stored(), 0);
  assert.deepEqual(await getAllResponses(), {});
});

test("a patch leaves fields it doesn't mention alone", async () => {
  useTempHome();

  await updateResponses("o/r#1", {
    t1: {
      done: true,
      reply: "draft",
      addCommit: { sha: SHA_A, patchId: null },
    },
  });
  await updateResponses("o/r#1", { t1: { commits: [] } });

  const forPr = await getResponses("o/r#1");
  assert.equal(forPr.t1.done, true, "clearing the link can't untick");
  assert.equal(forPr.t1.reply, "draft");
  assert.equal(forPr.t1.commits[0] ?? null, null);
});

test("invalid input is rejected before anything is written", async () => {
  useTempHome();

  await assert.rejects(
    () =>
      updateResponses("o/r#1", {
        t1: { addCommit: { sha: "xyz", patchId: null } },
      }),
    /Invalid commit sha/,
  );
  await assert.rejects(
    () => updateResponses("o/r#1", { t1: { reply: "x".repeat(20_001) } }),
    /too long/,
  );
  for (const reply of [123, {}, true]) {
    await assert.rejects(
      () =>
        updateResponses("o/r#1", {
          t1: { reply: reply as unknown as string },
        }),
      /Invalid reply/,
    );
  }
  await assert.rejects(
    () => updateResponses("o/r#1", { "bad id!": { done: true } }),
    /Invalid thread id/,
  );
});

test("one bad patch among several writes none of them", async () => {
  useTempHome();
  await updateResponses("o/r#1", { t0: { reply: "before" } });

  await assert.rejects(
    () =>
      updateResponses("o/r#1", {
        t0: { reply: "after" },
        t1: { done: true },
        t2: { addCommit: { sha: "xyz", patchId: null } },
        t3: { done: true },
      }),
    /Invalid commit sha/,
  );
  assert.deepEqual(Object.keys(await getResponses("o/r#1")), ["t0"]);
  assert.equal((await getResponses("o/r#1")).t0.reply, "before");
});

test("a comment can hold several commits, and drop one without the others", async () => {
  // A long comment often makes several points and takes more than one commit
  // to answer. With a single slot the second one was invisible.
  useTempHome();
  await updateResponses("o/r#1", {
    t1: { addCommit: { sha: SHA_A, patchId: PATCH_A } },
  });
  await updateResponses("o/r#1", {
    t1: { addCommit: { sha: SHA_B, patchId: PATCH_B } },
  });
  assert.deepEqual(
    (await getResponses("o/r#1")).t1.commits.map((c) => c.sha),
    [SHA_A, SHA_B],
    "kept in the order they were linked",
  );

  // Linking the same commit twice is one answer, not two.
  await updateResponses("o/r#1", {
    t1: { addCommit: { sha: SHA_A, patchId: PATCH_A } },
  });
  assert.equal((await getResponses("o/r#1")).t1.commits.length, 2);

  await updateResponses("o/r#1", { t1: { removeCommit: SHA_A } });
  assert.deepEqual(
    (await getResponses("o/r#1")).t1.commits.map((c) => c.sha),
    [SHA_B],
  );
});

test("a list that names one commit twice keeps it once", async () => {
  useTempHome();
  const commit = { sha: SHA_A, patchId: PATCH_A };
  const forPr = await updateResponses("o/r#1", {
    t1: { commits: [commit, { sha: SHA_B, patchId: PATCH_B }, commit] },
  });
  assert.deepEqual(
    forPr.t1.commits.map((c) => c.sha),
    [SHA_A, SHA_B],
  );
});

test("a record stored with the old single `commit` still reads", async () => {
  const home = useTempHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "responses.json"),
    JSON.stringify({
      "o/r#1": {
        t1: {
          done: true,
          doneAt: 1,
          reply: null,
          commit: { sha: SHA_A, patchId: PATCH_A },
        },
      },
    }),
  );

  const forPr = await getResponses("o/r#1");
  assert.deepEqual(forPr.t1.commits, [{ sha: SHA_A, patchId: PATCH_A }]);
  assert.equal(forPr.t1.done, true);
});
