-- Upgrades a database from version 2 to 3: drops the responses table, as
-- review comments are now read-only.
DROP TABLE IF EXISTS responses;
