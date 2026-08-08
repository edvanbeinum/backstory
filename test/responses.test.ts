import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getAllResponses,
  getResponses,
  resetMigrationForTests,
  updateResponses,
} from "../lib/responses";

/**
 * Point the store at a temp directory and put the module back in its
 * just-started state.
 *
 * Both halves matter. The store resolves `~/.differ` per call so DIFFER_HOME
 * can redirect it — without that these tests would migrate the real file,
 * which holds the only copy of your drafts. And the migration is memoised per
 * process, so it has to be reset or every test after the first would find it
 * already done.
 */
function useTempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "differ-test-"));
  process.env.DIFFER_HOME = home;
  resetMigrationForTests();
  return home;
}

/** Stands in for "a new server process against the same files". */
function restart(): void {
  resetMigrationForTests();
}

const read = async (home: string, name: string) =>
  JSON.parse(await fs.readFile(path.join(home, `${name}.json`), "utf8"));

const exists = async (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const SHA_A = "76c66deaa060ae3da0ff460e13aabfff3de885c4";
const PATCH_A = "5265095d7fd0b28d9cb0360ffa675bdc5f5cd38d";
const SHA_B = "822fc14ef375c27445f3472f2d6b093035f27637";
const PATCH_B = "2a5465a29bd69a77c8855480cdc45ab5b6382484";

test("migration carries all three link shapes plus drafts", async () => {
  const home = useTempHome();
  await fs.mkdir(home, { recursive: true });

  // Every shape links.json has ever held. The untagged {sha, patchId} is not
  // a historical curiosity — it is 9 of the 10 records in the live file.
  await fs.writeFile(
    path.join(home, "links.json"),
    JSON.stringify({
      "Indee/indee-ios#28": {
        legacy_untagged: { sha: SHA_A, patchId: PATCH_A },
        legacy_bare: SHA_B,
      },
      "Indee/indee-rails#1589": {
        tagged_commit: { kind: "commit", sha: SHA_B, patchId: PATCH_B },
        tagged_ack: { kind: "ack" },
      },
    }),
  );
  await fs.writeFile(
    path.join(home, "drafts.json"),
    JSON.stringify({
      "Indee/indee-ios#28": {
        legacy_untagged: "Addressed in 76c66de",
        // The case a links-driven migration would silently drop: a reply in
        // progress on a comment with no link. The live file has one.
        draft_only: "Still thinking about this one",
      },
    }),
  );

  const ios = await getResponses("Indee/indee-ios#28");
  assert.deepEqual(ios.legacy_untagged.commit, {
    sha: SHA_A,
    patchId: PATCH_A,
  });
  assert.equal(ios.legacy_untagged.done, true, "a link was the done signal");
  assert.equal(ios.legacy_untagged.reply, "Addressed in 76c66de");

  assert.deepEqual(ios.legacy_bare.commit, { sha: SHA_B, patchId: null });
  assert.equal(ios.legacy_bare.done, true);

  assert.equal(ios.draft_only.done, false, "a draft alone is not handled");
  assert.equal(ios.draft_only.reply, "Still thinking about this one");
  assert.equal(ios.draft_only.commit, null);

  const rails = await getResponses("Indee/indee-rails#1589");
  assert.deepEqual(rails.tagged_commit.commit, { sha: SHA_B, patchId: PATCH_B });
  assert.equal(rails.tagged_commit.done, true);
  assert.equal(rails.tagged_ack.done, true, "an ack was also a done signal");
  assert.equal(rails.tagged_ack.commit, null, "but it never had a commit");

  // Renamed, not deleted — recovering a store by hand is why it's JSON.
  assert.equal(await exists(path.join(home, "links.json")), false);
  assert.equal(await exists(path.join(home, "links.json.migrated")), true);
  assert.equal(await exists(path.join(home, "drafts.json.migrated")), true);
});

test("migration preserves the handled count, including a stale link", async () => {
  const home = useTempHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "links.json"),
    JSON.stringify({
      "Indee/indee-ios#40": {
        live: { sha: SHA_A, patchId: PATCH_A },
        // Rebased away. Today this reads as unaddressed, which is why #40
        // shows "1 of 7" rather than 2 — after migration it stays ticked,
        // because a rebase can't undo a judgement you made.
        stale: { sha: SHA_B, patchId: PATCH_B },
      },
    }),
  );

  const forPr = await getResponses("Indee/indee-ios#40");
  assert.equal(Object.values(forPr).filter((r) => r.done).length, 2);
});

test("migration is idempotent and never resurrects a cleared record", async () => {
  const home = useTempHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "links.json"),
    JSON.stringify({ "o/r#1": { t1: { sha: SHA_A, patchId: PATCH_A } } }),
  );

  await getResponses("o/r#1");
  await updateResponses("o/r#1", { t1: null });

  // Put the legacy file back and re-run in a fresh module: responses.json
  // already exists, so the migration must decline to undo the clear.
  await fs.writeFile(
    path.join(home, "links.json"),
    JSON.stringify({ "o/r#1": { t1: { sha: SHA_A, patchId: PATCH_A } } }),
  );
  restart();
  assert.deepEqual(await getResponses("o/r#1"), {});
});

test("a tick and a draft save on the same record don't clobber each other", async () => {
  const home = useTempHome();

  // The exact collision that merging links.json and drafts.json creates: the
  // 600ms debounced reply save and the tick land on one record at once.
  await Promise.all([
    updateResponses("o/r#1", { t1: { done: true } }),
    updateResponses("o/r#1", { t1: { reply: "Addressed in abc1234" } }),
    updateResponses("o/r#1", {
      t1: { commit: { sha: SHA_A, patchId: PATCH_A } },
    }),
  ]);

  const forPr = await getResponses("o/r#1");
  assert.equal(forPr.t1.done, true, "the tick survived");
  assert.equal(forPr.t1.reply, "Addressed in abc1234", "the draft survived");
  assert.deepEqual(forPr.t1.commit, { sha: SHA_A, patchId: PATCH_A });
  assert.ok(await exists(path.join(home, "responses.json")));
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
  const home = useTempHome();

  await updateResponses("o/r#1", { t1: { done: true, reply: "hi" } });
  await updateResponses("o/r#1", { t1: { done: false, reply: null } });

  const stored = await read(home, "responses");
  assert.deepEqual(stored, {}, "the PR namespace goes too once it's empty");
});

test("a patch leaves fields it doesn't mention alone", async () => {
  useTempHome();

  await updateResponses("o/r#1", {
    t1: { done: true, reply: "draft", commit: { sha: SHA_A, patchId: null } },
  });
  await updateResponses("o/r#1", { t1: { commit: null } });

  const forPr = await getResponses("o/r#1");
  assert.equal(forPr.t1.done, true, "clearing the link can't untick");
  assert.equal(forPr.t1.reply, "draft");
  assert.equal(forPr.t1.commit, null);
});

test("garbage in the file is dropped, not thrown", async () => {
  const home = useTempHome();
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(home, "responses.json"),
    JSON.stringify({
      "o/r#1": {
        good: { done: true, doneAt: 1, reply: null, commit: null },
        bad_commit: { done: true, commit: { sha: "nope" } },
        "not a key!": { done: true },
      },
    }),
  );

  const forPr = await getResponses("o/r#1");
  assert.equal(forPr.good.done, true);
  assert.equal(forPr.bad_commit.commit, null, "an unusable sha is dropped");
  assert.equal(forPr.bad_commit.done, true, "without losing the tick");
  assert.ok(!("not a key!" in forPr));
});

test("invalid input is rejected before anything is written", async () => {
  useTempHome();

  await assert.rejects(
    () => updateResponses("o/r#1", { t1: { commit: { sha: "xyz", patchId: null } } }),
    /Invalid commit sha/,
  );
  await assert.rejects(
    () => updateResponses("o/r#1", { t1: { reply: "x".repeat(20_001) } }),
    /too long/,
  );
  await assert.rejects(
    () => updateResponses("o/r#1", { "bad id!": { done: true } }),
    /Invalid thread id/,
  );
});
