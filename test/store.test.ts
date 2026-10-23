import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WORKING_REV } from "../lib/constants";
import { changeNotes, getNotes } from "../lib/notes";
import { getOutbox } from "../lib/outbox";
import { db, setSetting, setting, transaction } from "../lib/store";
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

const version = () =>
  (
    db().prepare("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;

const hasTable = (name: string) =>
  db()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;

test("a home with no JSON files makes an empty database at version 4, with no responses table", () => {
  tempHome();
  assert.equal(version(), 4);
  for (const table of ["notes", "rounds", "seen", "settings", "looked"]) {
    assert.equal(count(table), 0, table);
  }
  assert.equal(hasTable("responses"), false);
});

test("a setting reads back as it was set, and null when never set", () => {
  tempHome();
  assert.equal(setting("read.off.x"), null);
  setSetting("read.off.x", "1");
  assert.equal(setting("read.off.x"), "1");
  setSetting("read.off.x", "0");
  assert.equal(setting("read.off.x"), "0");
  assert.equal(count("settings"), 1);
});

/** The responses table as version 2 of the schema made it. */
const RESPONSES_V2 = `CREATE TABLE responses (
  pr TEXT NOT NULL,
  thread TEXT NOT NULL,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  done_at INTEGER,
  reply TEXT,
  commits TEXT NOT NULL CHECK (json_valid(commits)),
  PRIMARY KEY (pr, thread)
);`;

test("a database at version 1 opens at version 4 with a settings table, its rows intact", () => {
  const home = tempHome();
  db()
    .prepare(`INSERT INTO seen (root, session, at) VALUES ('/repo', 's-1', 1)`)
    .run();
  db().exec(
    `DROP TABLE settings; DROP TABLE looked; ${RESPONSES_V2} PRAGMA user_version = 1;`,
  );
  reopen(home);
  assert.equal(version(), 4);
  assert.equal(count("seen"), 1);
  assert.equal(hasTable("responses"), false);
  setSetting("read.off.x", "1");
  assert.equal(setting("read.off.x"), "1");
});

test("a database at version 2 loses its responses table on upgrade, and keeps every other row", async () => {
  const home = tempHome();
  await changeNotes("/repo", {
    op: "save",
    note: { ...NOTE, sentAt: null, done: false, doneAt: null },
  });
  db().exec(
    `INSERT INTO rounds (root, id, note_ids, message, queued_at)
       VALUES ('/repo', 'r1', '["n1"]', 'why?', 5);
     INSERT INTO seen (root, session, at) VALUES ('/repo', 's-1', 4);
     DROP TABLE looked;
     ${RESPONSES_V2}
     INSERT INTO responses (pr, thread, done, done_at, reply, commits)
       VALUES ('o/r#1', 't1', 1, 1, 'hi', '[]');
     PRAGMA user_version = 2;`,
  );
  setSetting("read.off.x", "1");

  reopen(home);
  assert.equal(version(), 4);
  assert.equal(hasTable("responses"), false);
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.deepEqual(
    (await getOutbox("/repo")).rounds.map((r) => r.id),
    ["r1"],
  );
  assert.equal(count("seen"), 1);
  assert.equal(setting("read.off.x"), "1");
});

test("a database at version 3 gains an empty looked table on upgrade, and keeps every other row", async () => {
  const home = tempHome();
  await changeNotes("/repo", {
    op: "save",
    note: { ...NOTE, sentAt: null, done: false, doneAt: null },
  });
  db().exec(
    `INSERT INTO rounds (root, id, note_ids, message, queued_at)
       VALUES ('/repo', 'r1', '["n1"]', 'why?', 5);
     INSERT INTO seen (root, session, at) VALUES ('/repo', 's-1', 4);
     DROP TABLE looked;
     PRAGMA user_version = 3;`,
  );
  setSetting("read.off.x", "1");

  reopen(home);
  assert.equal(version(), 4);
  assert.equal(count("looked"), 0);
  assert.deepEqual(primaryKey("looked"), ["common_dir", "branch"]);
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.deepEqual(
    (await getOutbox("/repo")).rounds.map((r) => r.id),
    ["r1"],
  );
  assert.equal(count("seen"), 1);
  assert.equal(setting("read.off.x"), "1");
});

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

function writeBoth(home: string): void {
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
}

test("a first start imports every valid record from both files, and renames them", async () => {
  const home = tempHome();
  writeBoth(home);

  assert.deepEqual(await getNotes("/repo"), [NOTE]);
  assert.deepEqual(await getOutbox("/repo"), {
    rounds: [{ ...ROUND, id: "r1", root: "/repo" }],
    lastSeen: { session: "s-1", at: 4 },
    seen: { "s-1": 4 },
  });
  for (const name of ["notes", "outbox"]) {
    assert.ok(!existsSync(path.join(home, `${name}.json`)), name);
    assert.ok(existsSync(path.join(home, `${name}.json.migrated`)), name);
  }

  // Put the files back: a second start finds the database and leaves them.
  writeBoth(home);
  writeJson(home, "notes", { "/repo": { n2: { ...NOTE, id: "n2" } } });
  reopen(home);
  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.equal(count("rounds"), 1);
  assert.ok(existsSync(path.join(home, "notes.json")));
});

test("a file that won't rename keeps the import, and leaves the others renamed", async () => {
  const home = tempHome();
  writeBoth(home);
  // A directory in the way makes renaming outbox.json fail.
  mkdirSync(path.join(home, "outbox.json.migrated"));

  assert.deepEqual(
    (await getNotes("/repo")).map((n) => n.id),
    ["n1"],
  );
  assert.equal(count("rounds"), 1);
  assert.ok(existsSync(path.join(home, "outbox.json")));
  assert.ok(existsSync(path.join(home, "notes.json.migrated")));
});

test("a responses.json is neither imported nor touched", () => {
  const home = tempHome();
  const file = path.join(home, "responses.json");
  const old = JSON.stringify({ "o/r#1": { t1: { done: true, doneAt: 1 } } });
  writeFileSync(file, old);

  db();
  assert.equal(hasTable("responses"), false);
  for (const table of ["notes", "rounds", "seen"]) {
    assert.equal(count(table), 0, table);
  }
  assert.equal(readFileSync(file, "utf8"), old);
  assert.ok(!existsSync(`${file}.migrated`));
});

test("a time too large to read back is refused, and a fractional one is kept", async () => {
  const home = tempHome();
  writeJson(home, "outbox", {
    "/repo": { r1: ROUND, r2: { ...ROUND, queuedAt: 2 ** 60 } },
  });
  writeJson(home, "notes", {
    "/repo": {
      n1: { ...NOTE, doneAt: 1786114704182.595 },
      n2: { ...NOTE, id: "n2", createdAt: 2 ** 60 },
    },
  });

  assert.deepEqual(await getNotes("/repo"), [
    { ...NOTE, doneAt: 1786114704182.595 },
  ]);
  assert.deepEqual(
    (await getOutbox("/repo")).rounds.map((r) => r.id),
    ["r1"],
  );

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
  writeJson(home, "outbox", { "/repo": { r1: ROUND } });

  assert.throws(() => db(), /EISDIR/);
  assert.deepEqual(await getNotes("/repo"), []);
  assert.ok(existsSync(path.join(home, "outbox.json")));

  rmdirSync(path.join(home, "notes.json"));
  writeJson(home, "notes", { "/repo": { n1: NOTE } });
  assert.deepEqual(await getNotes("/repo"), [NOTE]);
  assert.equal(count("rounds"), 1);
  assert.ok(existsSync(path.join(home, "notes.json.migrated")));
});

const primaryKey = (table: string) =>
  (
    db().prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

test("a new database has the tables, keys and checks in lib/schema.sql", () => {
  tempHome();
  assert.deepEqual(primaryKey("notes"), ["root", "id"]);
  assert.deepEqual(primaryKey("rounds"), ["root", "id"]);
  assert.deepEqual(primaryKey("seen"), ["root", "session"]);
  assert.deepEqual(primaryKey("looked"), ["common_dir", "branch"]);
  assert.equal(version(), 4);

  const rejects = (sql: string) =>
    assert.throws(() => db().prepare(sql).run(), /CHECK constraint failed/);
  rejects(
    `INSERT INTO notes (root, id, rev, side, body, created_at, sent_at, done)
     VALUES ('/repo', 'n1', 'working', 'new', 'fix it', 1, NULL, 1)`,
  );
  rejects(
    `INSERT INTO rounds (root, id, note_ids, message, queued_at)
     VALUES ('/repo', 'r1', 'not json', 'fix it', 1)`,
  );
  rejects(
    `INSERT INTO rounds (root, id, note_ids, message, queued_at, claim_session, claim_until)
     VALUES ('/repo', 'r1', '[]', 'fix it', 1, 's-1', NULL)`,
  );
});

test("lib/store.ts leaves the schema to lib/schema.sql", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "..", "lib", "store.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /CREATE TABLE/i);
});

test("a missing lib/schema.sql fails the open, and the next open makes the database", () => {
  tempHome();
  const repo = process.cwd();
  process.chdir(mkdtempSync(path.join(tmpdir(), "backstory-cwd-")));
  try {
    assert.throws(() => db(), /ENOENT/);
  } finally {
    process.chdir(repo);
  }
  for (const table of ["notes", "rounds", "seen", "settings", "looked"]) {
    assert.equal(count(table), 0, table);
  }
});
