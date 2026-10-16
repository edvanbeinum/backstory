import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WORKING_REV } from "../lib/constants";
import { getNotes } from "../lib/notes";
import { db, transaction } from "../lib/store";

/** The store resolves BACKSTORY_HOME per call; never touch the real home. */
function tempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "backstory-store-"));
  process.env.BACKSTORY_HOME = home;
  return home;
}

const count = (table: string) =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a failure inside a transaction leaves every table unchanged", () => {
  tempHome();
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
  tempHome();
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

const writeJson = (home: string, name: string, data: unknown) =>
  writeFileSync(path.join(home, `${name}.json`), JSON.stringify(data));

/** Stands in for a new server process: open another home, then this one again. */
function reopen(home: string): void {
  tempHome();
  db();
  process.env.BACKSTORY_HOME = home;
}

test("a note saved before rounds existed imports as a draft on uncommitted work", async () => {
  const home = tempHome();
  writeJson(home, "notes", {
    "/repo/legacy": {
      old: {
        id: "old",
        path: "src/a.ts",
        side: "new",
        line: 3,
        quote: "x",
        body: "fix this",
        createdAt: 1,
      },
    },
  });

  const [read] = await getNotes("/repo/legacy");
  assert.equal(read.id, "old");
  // Before notes could go on commits, uncommitted work was the only place.
  assert.equal(read.rev, WORKING_REV);
  assert.equal(read.sentAt, null);
  assert.equal(read.done, false);
  assert.equal(read.doneAt, null);
  assert.ok(existsSync(path.join(home, "notes.json.migrated")));
  assert.ok(!existsSync(path.join(home, "notes.json")));
});

test("a home with no JSON files makes an empty database at version 1", () => {
  tempHome();
  const { user_version } = db().prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  assert.equal(user_version, 1);
  for (const table of ["notes", "rounds", "seen", "responses"]) {
    assert.equal(count(table), 0, table);
  }
});

test("a second start neither imports again nor fails", async () => {
  const home = tempHome();
  const note = {
    id: "n1",
    rev: WORKING_REV,
    path: null,
    side: "new",
    line: null,
    quote: null,
    body: "general",
    createdAt: 1,
    sentAt: null,
    done: false,
    doneAt: null,
  };
  writeJson(home, "notes", { "/repo": { n1: note } });
  assert.equal((await getNotes("/repo")).length, 1);

  writeJson(home, "notes", { "/repo": { n2: { ...note, id: "n2" } } });
  reopen(home);
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.ok(existsSync(path.join(home, "notes.json")));
});
