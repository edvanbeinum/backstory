import assert from "node:assert/strict";
import { test } from "node:test";

import { readSql } from "../lib/data/sql";
import type { Entity } from "../lib/data/types";

const read = (files: Record<string, string>) =>
  readSql(new Map(Object.entries(files))).entities;

const fields = (e: Entity | undefined) =>
  e?.fields.map((f) => [f.name, f.type, f.required]);
const rules = (e: Entity | undefined) =>
  e?.constraints.map((c) => [c.kind, c.fields.join(","), c.target ?? null]);
const links = (e: Entity | undefined) =>
  e?.relationships.map((r) => [r.name, r.kind, r.target, r.fields?.join()]);

test("a MySQL schema: backticks, lengths, unique keys and named foreign keys", () => {
  const entities = read({
    "pkg/mysql/schema/keys.sql": `
CREATE TABLE \`keys\` (
  \`id\` varchar(256) NOT NULL,
  \`key_auth_id\` varchar(256) NOT NULL,
  \`workspace_id\` varchar(256) NOT NULL,
  \`name\` varchar(256),
  \`default_prefix\` varchar(8),
  \`key\` varchar(256) NOT NULL,
  \`state\` enum('active','revoked') NOT NULL DEFAULT 'active',
  \`created_at_m\` bigint NOT NULL DEFAULT 0,
  CONSTRAINT \`keys_id\` PRIMARY KEY(\`id\`),
  UNIQUE KEY \`unique_name_per_workspace\` (\`workspace_id\`, \`name\`),
  KEY \`key_auth_id_idx\` (\`key_auth_id\`),
  CONSTRAINT \`keys_workspace_fk\` FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`,
    "pkg/mysql/schema/workspaces.sql": `CREATE TABLE IF NOT EXISTS workspaces (
  id varchar(256) NOT NULL,
  amount numeric(10, 2),
  PRIMARY KEY (id)
);`,
  });
  assert.deepEqual([...entities.keys()], ["Key", "Workspace"]);
  const key = entities.get("Key");
  assert.equal(key?.file, "pkg/mysql/schema/keys.sql");
  assert.deepEqual(fields(key), [
    ["id", "varchar(256)", true],
    ["key_auth_id", "varchar(256)", true],
    ["workspace_id", "varchar(256)", true],
    ["name", "varchar(256)", false],
    ["default_prefix", "varchar(8)", false],
    ["key", "varchar(256)", true],
    ["state", "enum", true],
    ["created_at_m", "bigint", true],
  ]);
  assert.deepEqual(key?.fields.find((f) => f.name === "state")?.values, [
    "active",
    "revoked",
  ]);
  assert.deepEqual(rules(key), [
    ["unique", "workspace_id,name", null],
    ["foreign key", "workspace_id", "Workspace"],
  ]);
  assert.deepEqual(links(key), [
    ["workspace", "belongs to", "Workspace", "workspace_id"],
  ]);
  assert.deepEqual(fields(entities.get("Workspace")), [
    ["id", "varchar(256)", true],
    ["amount", "numeric(10, 2)", false],
  ]);
});

test("a Postgres dump: schema-qualified names, enum types, rules added after", () => {
  const entities = read({
    "db/structure.sql": `
SET statement_timeout = 0;
CREATE TYPE public.status AS ENUM (
    'draft',
    'published'
);
CREATE TABLE public.users (
    id bigint NOT NULL,
    "Email" character varying(255) NOT NULL,
    created_at timestamp(6) without time zone NOT NULL
);
CREATE TABLE public.posts (
    id bigint NOT NULL,
    user_id bigint,
    status public.status DEFAULT 'draft'::public.status NOT NULL,
    tags text[]
);
CREATE SEQUENCE public.posts_id_seq START WITH 1;
ALTER TABLE ONLY public.posts ALTER COLUMN id SET DEFAULT nextval('public.posts_id_seq'::regclass);
ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.posts
    ADD CONSTRAINT fk_rails_5b5ddfd518 FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE ("Email");
CREATE UNIQUE INDEX index_posts_on_user_id_and_status ON public.posts USING btree (user_id, status);
CREATE INDEX index_posts_on_status ON public.posts USING btree (status);
`,
  });
  const user = entities.get("User");
  const post = entities.get("Post");
  assert.deepEqual(fields(user), [
    ["id", "bigint", true],
    ["Email", "character varying(255)", true],
    ["created_at", "timestamp(6) without time zone", true],
  ]);
  assert.deepEqual(rules(user), [["unique", "Email", null]]);
  assert.deepEqual(fields(post), [
    ["id", "bigint", true],
    ["user_id", "bigint", false],
    ["status", "public.status", true],
    ["tags", "text[]", false],
  ]);
  assert.deepEqual(post?.fields.find((f) => f.name === "status")?.values, [
    "draft",
    "published",
  ]);
  assert.deepEqual(rules(post), [
    ["unique", "user_id,status", null],
    ["foreign key", "user_id", "User"],
  ]);
  assert.deepEqual(links(post), [["user", "belongs to", "User", "user_id"]]);
});

test("comments and strings don't split statements; other statements are skipped", () => {
  const entities = read({
    "schema.sql": `
-- The notes; one per commit
/* CREATE TABLE ghosts (id int); */
CREATE TABLE notes (
  id integer NOT NULL, -- the key; never reused
  body text DEFAULT 'a; b' NOT NULL,
  quote text DEFAULT 'it''s; fine'
);
CREATE INDEX notes_body ON notes (body);
INSERT INTO notes (id, body) VALUES (1, 'CREATE TABLE fake (id int);');
CREATE VIEW recent AS SELECT * FROM notes;
`,
  });
  assert.deepEqual([...entities.keys()], ["Note"]);
  assert.deepEqual(fields(entities.get("Note")), [
    ["id", "integer", true],
    ["body", "text", true],
    ["quote", "text", false],
  ]);
  assert.deepEqual(rules(entities.get("Note")), []);
});

test("inline rules: REFERENCES gives a belongs-to, UNIQUE a rule, PRIMARY KEY makes it required", () => {
  const entities = read({
    "db/schema.sql": `
CREATE TABLE key_auth (id serial PRIMARY KEY);
CREATE TABLE api_keys (
  id serial PRIMARY KEY,
  hash text UNIQUE,
  key_auth_id integer REFERENCES key_auth(id) ON DELETE CASCADE,
  ownerId integer REFERENCES key_auth
);
`,
  });
  const key = entities.get("ApiKey");
  assert.ok(entities.has("KeyAuth"));
  assert.deepEqual(fields(key), [
    ["id", "serial", true],
    ["hash", "text", false],
    ["key_auth_id", "integer", false],
    ["ownerId", "integer", false],
  ]);
  assert.deepEqual(rules(key), [
    ["unique", "hash", null],
    ["foreign key", "key_auth_id", "KeyAuth"],
    ["foreign key", "ownerId", "KeyAuth"],
  ]);
  assert.deepEqual(links(key), [
    ["key_auth", "belongs to", "KeyAuth", "key_auth_id"],
    ["owner", "belongs to", "KeyAuth", "ownerId"],
  ]);
});

test("an index on an expression keeps the expression; a prefix length keeps the column", () => {
  const entities = read({
    "db/schema.sql": `
CREATE TABLE users (email text, username text, handle varchar(500), UNIQUE KEY (handle(191)));
CREATE UNIQUE INDEX users_lower_email ON users (lower(email), username DESC);
`,
  });
  assert.deepEqual(rules(entities.get("User")), [
    ["unique", "handle", null],
    ["unique", "lower(email),username", null],
  ]);
});

test("a table-level primary key makes its fields required, wherever it's declared", () => {
  const entities = read({
    "db/schema.sql": `
CREATE TABLE pairs (PRIMARY KEY (a, b), a integer, b integer, note text);
CREATE TABLE tags (id integer, CONSTRAINT tags_pkey PRIMARY KEY (id));
CREATE TABLE labels (id integer);
ALTER TABLE ONLY labels ADD CONSTRAINT labels_pkey PRIMARY KEY (id);
`,
  });
  assert.deepEqual(fields(entities.get("Pair")), [
    ["a", "integer", true],
    ["b", "integer", true],
    ["note", "text", false],
  ]);
  assert.deepEqual(fields(entities.get("Tag")), [["id", "integer", true]]);
  assert.deepEqual(fields(entities.get("Label")), [["id", "integer", true]]);
  assert.deepEqual(rules(entities.get("Pair")), []);
});

test("same-named tables in two schemas are two entities, each keeping its own rules", () => {
  const entities = read({
    "db/structure.sql": `
CREATE TABLE public.users (id bigint NOT NULL, email text);
CREATE TABLE audit.users (id bigint NOT NULL, actor_id bigint);
CREATE TABLE notes (id bigint, user_id bigint REFERENCES users(id));
ALTER TABLE ONLY audit.users ADD CONSTRAINT audit_actor FOREIGN KEY (actor_id) REFERENCES public.users(id);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_email UNIQUE (email);
`,
  });
  assert.deepEqual([...entities.keys()], ["User", "AuditUser", "Note"]);
  assert.deepEqual(rules(entities.get("User")), [["unique", "email", null]]);
  assert.deepEqual(rules(entities.get("AuditUser")), [
    ["foreign key", "actor_id", "User"],
  ]);
  assert.deepEqual(fields(entities.get("AuditUser")), [
    ["id", "bigint", true],
    ["actor_id", "bigint", false],
  ]);
  assert.deepEqual(links(entities.get("Note")), [
    ["user", "belongs to", "User", "user_id"],
  ]);
});

test("a table's entity name holds whatever else is declared, and in whatever order", () => {
  const both = read({
    "db/structure.sql": `
CREATE TABLE audit.users (id bigint);
CREATE TABLE public.users (id bigint);
`,
  });
  assert.deepEqual([...both.keys()].sort(), ["AuditUser", "User"]);
  assert.deepEqual(fields(both.get("User")), [["id", "bigint", false]]);
  const alone = read({
    "db/structure.sql": "CREATE TABLE audit.users (id int);",
  });
  assert.deepEqual([...alone.keys()], ["AuditUser"]);
});

test("same-named enums in two schemas each give their own columns their values", () => {
  const entities = read({
    "db/structure.sql": `
CREATE TYPE public.status AS ENUM ('draft', 'live');
CREATE TYPE audit.status AS ENUM ('seen', 'flagged');
CREATE TYPE app.kind AS ENUM ('a', 'b');
CREATE TABLE public.posts (status public.status, plain status, kind kind);
CREATE TABLE audit.events (status audit.status);
`,
  });
  const values = (e: Entity | undefined) =>
    e?.fields.map((f) => [f.name, f.values ?? null]);
  assert.deepEqual(values(entities.get("Post")), [
    ["status", ["draft", "live"]],
    ["plain", ["draft", "live"]],
    ["kind", ["a", "b"]],
  ]);
  assert.deepEqual(values(entities.get("AuditEvent")), [
    ["status", ["seen", "flagged"]],
  ]);
});

test("a table declared twice is taken from the first file in path order", () => {
  const entities = read({
    "b/schema.sql": "CREATE TABLE items (b int);",
    "a/schema.sql": "CREATE TABLE items (a int);",
  });
  assert.equal(entities.get("Item")?.file, "a/schema.sql");
  assert.deepEqual(fields(entities.get("Item")), [["a", "int", false]]);
});
