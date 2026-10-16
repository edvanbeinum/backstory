import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { db, transaction } from "../lib/store";

/** The store resolves BACKSTORY_HOME per call; never touch the real home. */
function useTempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "backstory-store-"));
  process.env.BACKSTORY_HOME = home;
  return home;
}

const count = (table: string) =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a failure inside a transaction leaves every table unchanged", () => {
  useTempHome();
  const note = (id: string) =>
    db()
      .prepare(
        `INSERT INTO notes (root, id, rev, path, side, line, quote, body, created_at, sent_at, done, done_at)
         VALUES ('/repo', ?, 'working', NULL, 'new', NULL, NULL, 'fix it', 1, 2, 0, NULL)`,
      )
      .run(id);

  assert.throws(
    () =>
      transaction((database) => {
        note("n1");
        database
          .prepare(
            `INSERT INTO rounds (root, id, note_ids, message, queued_at)
             VALUES ('/repo', 'r1', '["n1"]', 'fix it', 2)`,
          )
          .run();
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(count("notes"), 0);
  assert.equal(count("rounds"), 0);

  // The connection is usable after the rollback.
  transaction(() => note("n2"));
  assert.equal(count("notes"), 1);
});

test("a transaction inside another joins it, and rolls back with it", () => {
  useTempHome();
  assert.throws(() =>
    transaction((database) => {
      transaction(() =>
        database
          .prepare(
            `INSERT INTO seen (root, session, at) VALUES ('/repo', 's-1', 1)`,
          )
          .run(),
      );
      throw new Error("boom");
    }),
  );
  assert.equal(count("seen"), 0);
});
