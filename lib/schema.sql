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
CREATE TABLE responses (
  pr TEXT NOT NULL,
  thread TEXT NOT NULL,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  done_at INTEGER,
  reply TEXT,
  commits TEXT NOT NULL CHECK (json_valid(commits)),
  PRIMARY KEY (pr, thread)
);
