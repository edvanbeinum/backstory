-- Run only when `db()` in lib/store.ts makes a new database, at its latest
-- version. An existing database never reads this file again, so a change here
-- also needs a lib/upgrades/<version>.sql that makes the same change, and
-- `VERSION` in lib/store.ts raised to match.
CREATE TABLE notes (
  root TEXT NOT NULL,
  id TEXT NOT NULL,
  rev TEXT NOT NULL,
  path TEXT,
  side TEXT NOT NULL CHECK (side IN ('old', 'new')),
  line INTEGER CHECK (line > 0),
  quote TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  done_at INTEGER,
  CHECK (done = 0 OR sent_at IS NOT NULL),
  CHECK (done = 1 OR done_at IS NULL),
  PRIMARY KEY (root, id)
);
CREATE TABLE rounds (
  root TEXT NOT NULL,
  id TEXT NOT NULL,
  note_ids TEXT NOT NULL CHECK (json_valid(note_ids)),
  message TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  for_session TEXT,
  delivered_at INTEGER,
  delivered_to TEXT,
  claim_session TEXT,
  claim_until INTEGER,
  CHECK ((claim_session IS NULL) = (claim_until IS NULL)),
  PRIMARY KEY (root, id)
);
CREATE TABLE seen (
  root TEXT NOT NULL,
  session TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (root, session)
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
