-- Upgrades a database from version 3 to 4: adds the looked table, the tip
-- each branch had when you last opened it.
CREATE TABLE looked (
  common_dir TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (common_dir, branch)
);
