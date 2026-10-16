-- Upgrades a database from version 1 to 2: adds the settings table.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
