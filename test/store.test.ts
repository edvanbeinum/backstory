import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WORKING_REV } from "../lib/constants";
import { changeNotes, getNotes } from "../lib/notes";
import { getOutbox } from "../lib/outbox";
import { getAllResponses, getResponses } from "../lib/responses";
import { db, transaction } from "../lib/store";
import type { Note } from "../lib/types";

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

test("a database that won't open reads as empty", async () => {
  const home = path.join(tempHome(), "not-a-directory");
  writeFileSync(home, "");
  process.env.BACKSTORY_HOME = home;

  assert.deepEqual(await getNotes("/repo"), []);
  assert.deepEqual(await getOutbox("/repo"), {
    rounds: [],
    lastSeen: null,
    seen: {},
  });
  assert.deepEqual(await getResponses("o/r#1"), {});
  assert.deepEqual(await getAllResponses(), {});
  assert.throws(() => transaction(() => null));
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

const SHA = "76c66deaa060ae3da0ff460e13aabfff3de885c4";
const PATCH = "5265095d7fd0b28d9cb0360ffa675bdc5f5cd38d";

const NOTE: Note = {
  id: "n1",
  rev: "a".repeat(40),
  path: "src/a.ts",
  side: "old",
  line: 7,
  quote: "gone",
  body: "why?",
  createdAt: 3,
  sentAt: 5,
  done: true,
  doneAt: 6,
};

const ROUND = {
  noteIds: ["n1"],
  message: "why?",
  queuedAt: 5,
  forSession: "s-1",
  deliveredAt: null,
  deliveredTo: null,
  claim: { session: "s-1", until: 99 },
};

function writeAllThree(home: string): void {
  writeJson(home, "notes", {
    "/repo": { n1: NOTE, bad: { ...NOTE, id: "bad", side: "up" } },
  });
  writeJson(home, "outbox", {
    "/repo": {
      r1: ROUND,
      seen: { "s-1": 4 },
      "r-bad": { ...ROUND, noteIds: "n1" },
    },
  });
  writeJson(home, "responses", {
    "o/r#1": {
      t1: {
        done: true,
        doneAt: 1,
        reply: "hi",
        commit: { sha: SHA, patchId: PATCH },
      },
      t2: "garbage",
    },
  });
}

test("a first start imports every valid record from the three files, and renames them", async () => {
  const home = tempHome();
  writeAllThree(home);

  assert.deepEqual(await getNotes("/repo"), [NOTE]);
  assert.deepEqual(await getOutbox("/repo"), {
    rounds: [{ ...ROUND, id: "r1", root: "/repo" }],
    lastSeen: { session: "s-1", at: 4 },
    seen: { "s-1": 4 },
  });
  assert.deepEqual(await getAllResponses(), {
    "o/r#1": {
      t1: {
        done: true,
        doneAt: 1,
        reply: "hi",
        commits: [{ sha: SHA, patchId: PATCH }],
      },
    },
  });
  for (const name of ["notes", "outbox", "responses"]) {
    assert.ok(!existsSync(path.join(home, `${name}.json`)), name);
    assert.ok(existsSync(path.join(home, `${name}.json.migrated`)), name);
  }

  // Put the files back: a second start finds the database and leaves them.
  writeAllThree(home);
  writeJson(home, "notes", { "/repo": { n2: { ...NOTE, id: "n2" } } });
  reopen(home);
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.equal(count("rounds"), 1);
  assert.equal(count("responses"), 1);
  assert.ok(existsSync(path.join(home, "notes.json")));
});

test("a file that won't rename keeps the import, and leaves the others renamed", async () => {
  const home = tempHome();
  writeAllThree(home);
  // A directory in the way makes renaming outbox.json fail.
  mkdirSync(path.join(home, "outbox.json.migrated"));

  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.equal(count("rounds"), 1);
  assert.ok(existsSync(path.join(home, "outbox.json")));
  assert.ok(existsSync(path.join(home, "notes.json.migrated")));
  assert.ok(existsSync(path.join(home, "responses.json.migrated")));
});

test("a home with only responses.json imports it, and the other tables are empty", async () => {
  const home = tempHome();
  writeJson(home, "responses", { "o/r#1": { t1: { done: true, doneAt: 1 } } });

  assert.equal((await getResponses("o/r#1")).t1.done, true);
  for (const table of ["notes", "rounds", "seen"]) {
    assert.equal(count(table), 0, table);
  }
  assert.ok(existsSync(path.join(home, "responses.json.migrated")));
});

test("a time too large to read back is refused, and a fractional one is kept", async () => {
  const home = tempHome();
  writeJson(home, "notes", {
    "/repo": { n1: NOTE, n2: { ...NOTE, id: "n2", createdAt: 2 ** 60 } },
  });
  writeJson(home, "outbox", {
    "/repo": { r1: ROUND, r2: { ...ROUND, queuedAt: 2 ** 60 } },
  });
  writeJson(home, "responses", {
    "o/r#1": { t1: { done: true, doneAt: 1786114704182.595 } },
  });

  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.deepEqual(
    (await getOutbox("/repo")).rounds.map((r) => r.id),
    ["r1"],
  );
  assert.equal((await getResponses("o/r#1")).t1.doneAt, 1786114704182.595);

  await assert.rejects(
    changeNotes("/repo", {
      op: "save",
      note: {
        ...NOTE,
        id: "n3",
        sentAt: null,
        done: false,
        createdAt: 2 ** 60,
      },
    }),
    /Invalid note/,
  );
  await assert.rejects(
    changeNotes("/repo", { op: "send", ids: ["n1"], at: 2 ** 60 }),
    /Invalid send time/,
  );
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
});

test("a JSON file that can't be read stops the open, and the next start imports it", async () => {
  const home = tempHome();
  // A directory where notes.json should be fails the read with EISDIR.
  mkdirSync(path.join(home, "notes.json"));
  writeJson(home, "responses", { "o/r#1": { t1: { done: true, doneAt: 1 } } });

  assert.throws(() => db(), /EISDIR/);
  assert.deepEqual(await getNotes("/repo"), []);
  assert.ok(existsSync(path.join(home, "responses.json")));

  rmdirSync(path.join(home, "notes.json"));
  writeJson(home, "notes", { "/repo": { n1: NOTE } });
  assert.deepEqual(await getNotes("/repo"), [NOTE]);
  assert.equal((await getResponses("o/r#1")).t1.done, true);
  assert.ok(existsSync(path.join(home, "notes.json.migrated")));
});
