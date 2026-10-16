import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Runner } from "../lib/ai/provider";
import { buildData } from "../lib/data/build";
import {
  dataReadSettled,
  dataStatus,
  startDataRead,
  type DataView,
} from "../lib/data/cache";
import { readCoreData } from "../lib/data/coredata";
import { diffModels } from "../lib/data/diff";
import {
  mergeDelta,
  TOO_LARGE,
  type DraftedDelta,
  type DraftedHead,
} from "../lib/data/drafted";
import { readRails, tableFor } from "../lib/data/rails";
import { DATA_READERS } from "../lib/data/readers";
import type { Constraint, DataModel, Entity } from "../lib/data/types";
import { localModelFile } from "../lib/model";

const repos: string[] = [];
after(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

/** A temp git repo, removed after the file's tests. */
function tempRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-data-"));
  repos.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  return { root, git, write, commit };
}

const schema = (itemColumns: string) => `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", id: :uuid, force: :cascade do |t|
    t.string "title", null: false
    t.uuid "space_id", null: false
${itemColumns}
    t.index ["space_id"], name: "index_items_on_space_id"
  end

  create_table "spaces", id: :uuid, force: :cascade do |t|
    t.string "name"
  end

  add_foreign_key "items", "spaces"
end
`;

const item = (extra: string) => `
class Item < ApplicationRecord
  belongs_to :space
  has_many :listings, dependent: :destroy
${extra}
end
`;

const space = `class Space < ApplicationRecord
  has_many :items
end
`;

test("Rails: fields from schema.rb, relationships and enums from the models", () => {
  const model = readRails({
    schema: schema(
      `    t.integer "zoom_import_status"\n    t.index ["space_id", "zoom_meeting_uuid"], name: "x", unique: true`,
    ),
    models: new Map([
      [
        "app/models/item.rb",
        item(
          `  enum :zoom_import_status, {import_pending: 0, import_complete: 1}`,
        ),
      ],
      ["app/models/space.rb", space],
    ]),
  });
  const it = model.entities.get("Item")!;
  assert.equal(it.file, "app/models/item.rb");
  assert.deepEqual(
    it.fields.find((f) => f.name === "title"),
    { name: "title", type: "string", required: true },
  );
  assert.deepEqual(
    it.fields.find((f) => f.name === "zoom_import_status")?.values,
    ["import_pending", "import_complete"],
  );
  assert.deepEqual(
    it.relationships.map((r) => [r.name, r.kind, r.target]),
    [
      ["space", "belongs to", "Space"],
      ["listings", "has many", "Listing"],
    ],
  );
  // A plain index is a performance detail; a unique one is a rule.
  assert.deepEqual(
    it.constraints.map((c) => [c.kind, c.fields.join(","), c.target ?? null]),
    [
      ["unique", "space_id,zoom_meeting_uuid", null],
      ["foreign key", "space_id", "Space"],
    ],
  );
});

test("table names follow Rails's conventions", () => {
  assert.equal(tableFor("Zoom::Recording"), "zoom_recordings");
  assert.equal(tableFor("Category"), "categories");
  assert.equal(tableFor("AccessGrant"), "access_grants");
});

test("a polymorphic relationship has no single target", () => {
  const model = readRails({
    schema: schema(`    t.uuid "source_id"\n    t.string "source_type"`),
    models: new Map([
      [
        "app/models/item.rb",
        item(`  belongs_to :source, polymorphic: true, optional: true`),
      ],
    ]),
  });
  const source = model.entities
    .get("Item")!
    .relationships.find((r) => r.name === "source");
  assert.deepEqual(source, {
    name: "source",
    kind: "belongs to",
    target: null,
    polymorphic: true,
    fields: ["source_type", "source_id"],
    candidates: [],
  });
});

test("a polymorphic relationship's kinds are the models that declare themselves one", () => {
  const recordingSchema = `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", force: :cascade do |t|
    t.uuid "source_id"
    t.string "source_type"
  end
  create_table "zoom_recordings", force: :cascade do |t|
    t.string "meeting_uuid", null: false
  end
end
`;
  const model = readRails({
    schema: recordingSchema,
    models: new Map([
      [
        "app/models/item.rb",
        `class Item < ApplicationRecord\n  belongs_to :source, polymorphic: true\nend\n`,
      ],
      [
        "app/models/zoom/recording.rb",
        `module Zoom\n  class Recording < ApplicationRecord\n    has_one :item, as: :source\n  end\nend\n`,
      ],
    ]),
  });
  assert.deepEqual(model.entities.get("Item")!.relationships[0].candidates, [
    "Zoom::Recording",
  ]);
  assert.equal(
    model.entities.get("Zoom::Recording")!.relationships[0].as,
    "source",
  );
});

test("the diff names what changed on each entity, with neighbours after", () => {
  const before = readRails({
    schema: schema(""),
    models: new Map([
      ["app/models/item.rb", item("")],
      ["app/models/space.rb", space],
    ]),
  });
  const after = readRails({
    schema: schema(`    t.string "zoom_meeting_uuid"`),
    models: new Map([
      ["app/models/item.rb", item("")],
      ["app/models/space.rb", space],
    ]),
  });
  const diff = diffModels(before, after);
  assert.deepEqual(
    diff.map((e) => [e.name, e.state]),
    [
      ["Item", "changed"],
      ["Space", "same"],
    ],
  );
  assert.deepEqual(
    diff[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => [f.state, f.item.name]),
    [["added", "zoom_meeting_uuid"]],
  );
  // No base model: nothing can be said to have changed.
  assert.deepEqual(diffModels(null, after), []);
});

test("Core Data: entities, attributes, relationships and uniqueness", () => {
  const model = readCoreData(
    `<model>
    <entity name="Movement" representedClassName="Movement">
        <attribute name="name" optional="YES" attributeType="String"/>
        <attribute name="id" attributeType="UUID"/>
        <relationship name="exercises" optional="YES" toMany="YES" destinationEntity="Exercise"/>
        <uniquenessConstraints><uniquenessConstraint><constraint value="id"/></uniquenessConstraint></uniquenessConstraints>
    </entity>
    <entity name="Exercise">
        <relationship name="movement" optional="YES" maxCount="1" destinationEntity="Movement"/>
    </entity>
</model>`,
    "App.xcdatamodeld/App.xcdatamodel/contents",
  );
  const m = model.entities.get("Movement")!;
  assert.deepEqual(m.fields, [
    { name: "name", type: "string", required: false },
    { name: "id", type: "uuid", required: true },
  ]);
  assert.deepEqual(m.relationships[0], {
    name: "exercises",
    kind: "has many",
    target: "Exercise",
    polymorphic: false,
  });
  assert.deepEqual(m.constraints, [{ kind: "unique", fields: ["id"] }]);
  assert.equal(
    model.entities.get("Exercise")!.relationships[0].kind,
    "belongs to",
  );
});

test("present: a link is said once, and bookkeeping waits for details", async () => {
  const { present } = await import("../lib/data/present");
  const before = readRails({
    schema: `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", force: :cascade do |t|
    t.string "title"
  end
  create_table "spaces", force: :cascade do |t|
    t.string "name"
  end
end
`,
    models: new Map([
      ["app/models/item.rb", `class Item < ApplicationRecord\nend\n`],
      ["app/models/space.rb", `class Space < ApplicationRecord\nend\n`],
    ]),
  });
  const after = readRails({
    schema: `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", force: :cascade do |t|
    t.string "title"
    t.uuid "source_id"
    t.string "source_type"
    t.index ["source_type", "source_id"], name: "x", unique: true
  end
  create_table "spaces", force: :cascade do |t|
    t.string "name"
  end
  create_table "zoom_recordings", force: :cascade do |t|
    t.string "meeting_uuid", null: false
    t.uuid "space_id", null: false
    t.datetime "created_at", null: false
  end
  add_foreign_key "zoom_recordings", "spaces"
end
`,
    models: new Map([
      [
        "app/models/item.rb",
        `class Item < ApplicationRecord\n  belongs_to :source, polymorphic: true\nend\n`,
      ],
      [
        "app/models/space.rb",
        `class Space < ApplicationRecord\n  has_many :zoom_recordings, class_name: "Zoom::Recording"\nend\n`,
      ],
      [
        "app/models/zoom/recording.rb",
        `module Zoom\n  class Recording < ApplicationRecord\n    belongs_to :space\n    has_one :item, as: :source\n  end\nend\n`,
      ],
    ]),
  });
  const shown = present(diffModels(before, after));
  const by = (n: string) => shown.find((p) => p.entity.name === n)!;

  // The new entity: its one real field; the link and the timestamp wait.
  assert.equal(by("Zoom::Recording").summary, "New · 1 field");
  assert.deepEqual(
    by("Zoom::Recording").fields.map((f) => f.item.name),
    ["meeting_uuid"],
  );
  assert.deepEqual(
    by("Zoom::Recording").details.timestamps.map((f) => f.item.name),
    ["created_at"],
  );
  // Its foreign key is the arrow to Space again; its has-one fills Item's link.
  assert.deepEqual(by("Zoom::Recording").details.rules, []);
  assert.deepEqual(by("Zoom::Recording").relationships, []);
  // Item: one relationship; its two columns and its rule are details.
  assert.equal(by("Item").summary, "+1 relationship");
  assert.deepEqual(by("Item").fields, []);
  assert.equal(by("Item").details.linkFields.length, 2);
  // Space only gained the far end of Zoom::Recording's link.
  assert.equal(by("Space").state, "same");
});

test("model files with non-ASCII text read whole, and so do the ones after them", async () => {
  const { buildData } = await import("../lib/data/build");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const repo = mkdtempSync(path.join(os.tmpdir(), "backstory-unicode-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  const write = (f: string, t: string) => {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), t);
  };
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    write(
      "db/schema.rb",
      `ActiveRecord::Schema[8.1].define(version: 1) do\n  create_table "items", force: :cascade do |t|\n    t.string "title"\n  end\n  create_table "posts", force: :cascade do |t|\n    t.string "title"\n  end\nend\n`,
    );
    // An em-dash-heavy comment, as real code has, before a later model.
    write(
      "app/models/item.rb",
      `# ${"— ".repeat(60)}\nclass Item < ApplicationRecord\nend\n`,
    );
    write(
      "app/models/post.rb",
      `class Post < ApplicationRecord\n  belongs_to :item\nend\n`,
    );
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write(
      "app/models/post.rb",
      `class Post < ApplicationRecord\n  belongs_to :item\n  has_many :comments\nend\n`,
    );
    git("commit", "-qam", "head");
    const data = await buildData(repo, base, git("rev-parse", "HEAD"));
    const post = data.entities.find((e) => e.name === "Post")!;
    assert.deepEqual(
      post.relationships
        .filter((r) => r.state !== "same")
        .map((r) => [r.state, r.item.name]),
      [["added", "comments"]],
    );
    assert.equal(
      data.entities.find((e) => e.name === "Item")?.state ?? "same",
      "same",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Rails inflections, quoting and enums as real apps write them", () => {
  assert.equal(tableFor("Person"), "people");
  assert.equal(tableFor("Status"), "statuses");
  const model = readRails({
    schema: `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "purchases", force: :cascade do |t|
    t.integer "role"
  end
  create_table "people", force: :cascade do |t|
    t.string "name"
  end
  create_table "access_grants", force: :cascade do |t|
    t.uuid "purchase_id"
  end
  add_foreign_key "access_grants", "purchases"
end
`,
    models: new Map([
      [
        "app/models/purchase.rb",
        `class Purchase < ApplicationRecord\n  belongs_to :buyer, class_name: 'Person'\n  enum :role, [:creator, :member]\nend\n`,
      ],
      [
        "app/models/person.rb",
        `class Person < ApplicationRecord\n  has_many :purchases, foreign_key: :buyer_id\nend\n`,
      ],
      [
        "app/models/access_grant.rb",
        `class AccessGrant < ApplicationRecord\n  belongs_to :purchase\nend\n`,
      ],
    ]),
  });
  assert.ok(model.entities.has("Person"), "people is Person's table");
  assert.equal(
    model.entities.get("Person")!.relationships[0].target,
    "Purchase",
  );
  assert.equal(
    model.entities.get("Purchase")!.relationships[0].target,
    "Person",
  );
  assert.deepEqual(model.entities.get("Purchase")!.fields[0].values, [
    "creator",
    "member",
  ]);
  const fk = model.entities
    .get("AccessGrant")!
    .constraints.find((c) => c.kind === "foreign key");
  assert.deepEqual(fk, {
    kind: "foreign key",
    fields: ["purchase_id"],
    target: "Purchase",
  });
});

test("an explicit class_name wins over a target guessed from source:", () => {
  const model = readRails({
    schema: `ActiveRecord::Schema[8.1].define(version: 1) do\n  create_table "spaces", force: :cascade do |t|\n  end\nend\n`,
    models: new Map([
      [
        "app/models/space.rb",
        `class Space < ApplicationRecord\n  has_many :members, through: :memberships, source: :owner, class_name: "User"\nend\n`,
      ],
    ]),
  });
  assert.equal(model.entities.get("Space")!.relationships[0].target, "User");
});

test("Rails: where: on a unique index and primary_key: on a foreign key", () => {
  const model = readRails({
    schema: `ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", force: :cascade do |t|
    t.string "email"
    t.string "handle"
    t.uuid "space_uuid"
    t.index ["email"], name: "x", unique: true, where: "status = 'active'"
    t.index ["handle"], name: "y", unique: true
  end
  create_table "spaces", force: :cascade do |t|
    t.uuid "uuid"
  end
  add_foreign_key "items", "spaces", primary_key: "uuid", column: "space_uuid"
  add_foreign_key "items", "spaces"
end
`,
    models: new Map(),
  });
  assert.deepEqual(model.entities.get("Item")!.constraints, [
    { kind: "unique", fields: ["email"], condition: "status = 'active'" },
    { kind: "unique", fields: ["handle"] },
    {
      kind: "foreign key",
      fields: ["space_uuid"],
      target: "Space",
      targetFields: ["uuid"],
    },
    { kind: "foreign key", fields: ["space_id"], target: "Space" },
  ]);
});

test("present: tightening a link that stays is a change, not plumbing", async () => {
  const { present } = await import("../lib/data/present");
  const schema = (spaceId: string, fk: string) => `
ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "items", force: :cascade do |t|
    t.string "title"
    ${spaceId}
  end
  create_table "spaces", force: :cascade do |t|
    t.string "name"
  end
  ${fk}
end
`;
  const models = new Map([
    [
      "app/models/item.rb",
      `class Item < ApplicationRecord\n  belongs_to :space\nend\n`,
    ],
    [
      "app/models/space.rb",
      `class Space < ApplicationRecord\n  has_many :items\nend\n`,
    ],
  ]);
  const before = readRails({
    schema: schema(`t.bigint "space_id"`, ""),
    models,
  });
  const notNull = readRails({
    schema: schema(`t.bigint "space_id", null: false`, ""),
    models,
  });
  const withFk = readRails({
    schema: schema(`t.bigint "space_id"`, `add_foreign_key "items", "spaces"`),
    models,
  });

  const tightened = present(diffModels(before, notNull)).find(
    (p) => p.entity.name === "Item",
  )!;
  assert.equal(tightened.state, "changed");
  assert.deepEqual(
    tightened.fields.map((f) => f.item.name),
    ["space_id"],
  );

  const constrained = present(diffModels(before, withFk)).find(
    (p) => p.entity.name === "Item",
  )!;
  assert.equal(constrained.state, "changed");
  assert.equal(constrained.summary, "+1 rule");
});

test("a unique rule's column order is no change; a foreign key's still is", () => {
  const model = (constraints: Constraint[]): DataModel => ({
    source: "rails",
    entities: new Map([
      [
        "Role",
        {
          name: "Role",
          file: null,
          fields: [],
          relationships: [],
          constraints,
        },
      ],
    ]),
  });
  const states = (before: Constraint, after: Constraint) =>
    diffModels(model([before]), model([after])).map((e) => e.state);

  assert.deepEqual(
    states(
      { kind: "unique", fields: ["name", "workspace_id"] },
      { kind: "unique", fields: ["workspace_id", "name"] },
    ),
    [],
  );
  assert.deepEqual(
    states(
      { kind: "foreign key", fields: ["a", "b"], target: "T" },
      { kind: "foreign key", fields: ["b", "a"], target: "T" },
    ),
    ["changed"],
  );
});

const coreData = `<model>
    <entity name="Movement">
        <attribute name="name" optional="YES" attributeType="String"/>
    </entity>
</model>`;

test("a repo with no data model lists every reader's label, in order", async () => {
  const repo = tempRepo();
  repo.write("README.md", "hello\n");
  const head = repo.commit("first");
  const data = await buildData(repo.root, null, head);
  assert.equal(data.status, "none");
  assert.deepEqual(
    data.readers,
    DATA_READERS.map((r) => r.label),
  );
  assert.deepEqual(data.readers, [
    "db/schema.rb and the models",
    "a Core Data model",
    "SQL schema files",
  ]);
});

const keysTable = (columns: string) => `CREATE TABLE \`keys\` (
  \`id\` varchar(256) NOT NULL,
${columns}
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;
`;

test("a repo with only SQL schema files shows its data model change, with nothing drafted", async () => {
  const repo = tempRepo();
  repo.write("db/schema.sql", keysTable(""));
  const base = repo.commit("keys");
  repo.write("db/schema.sql", keysTable("  `prefix` varchar(8),"));
  const head = repo.commit("store the prefix");
  const data = await buildData(repo.root, base, head);
  assert.equal(data.status, "ok");
  assert.equal(data.source, "sql");
  assert.equal(data.label, "SQL schema files");
  assert.equal(data.drafted, null);
  assert.equal(data.draft, undefined);
  assert.equal(data.baseModel, true);
  assert.deepEqual(
    data.entities.map((e) => [e.name, e.state, e.file]),
    [["Key", "changed", "db/schema.sql"]],
  );
  assert.deepEqual(
    data.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => [f.state, f.item.name, f.item.type]),
    [["added", "prefix", "varchar(8)"]],
  );
});

test("a widened SQL column reads as a changed field", async () => {
  const repo = tempRepo();
  repo.write("db/schema.sql", keysTable("  `prefix` varchar(8),"));
  const base = repo.commit("narrow");
  repo.write("db/schema.sql", keysTable("  `prefix` varchar(16),"));
  const head = repo.commit("wide");
  const data = await buildData(repo.root, base, head);
  const prefix = data.entities[0].fields.find((f) => f.item.name === "prefix");
  assert.equal(prefix?.state, "changed");
  assert.equal(prefix?.before?.type, "varchar(8)");
  assert.equal(prefix?.item.type, "varchar(16)");
});

test("SQL in migrations or tests, or with no CREATE TABLE, isn't a schema", async () => {
  const repo = tempRepo();
  repo.write("db/migrations/001_keys.sql", keysTable(""));
  repo.write("test/schema.sql", keysTable(""));
  repo.write("spec/fixtures/schema/keys.sql", keysTable(""));
  repo.write("db/schema.sql", "INSERT INTO keys (id) VALUES ('a');\n");
  const head = repo.commit("no schema");
  const data = await buildData(repo.root, null, head);
  assert.equal(data.status, "none");
  assert.deepEqual(
    data.readers,
    DATA_READERS.map((r) => r.label),
  );
});

test("a schema folder's rules kept apart from its tables still change the data model", async () => {
  const repo = tempRepo();
  repo.write("db/schema/tables.sql", keysTable("  `prefix` varchar(8),"));
  repo.write("db/schema/indexes.sql", "-- unique keys\n");
  const base = repo.commit("keys");
  repo.write(
    "db/schema/indexes.sql",
    "CREATE UNIQUE INDEX keys_prefix ON `keys` (`prefix`);\n",
  );
  const head = repo.commit("unique prefix");
  const data = await buildData(repo.root, base, head);
  assert.equal(data.source, "sql");
  assert.deepEqual(
    data.entities[0].constraints.map((c) => [c.state, c.item.fields.join()]),
    [["added", "prefix"]],
  );
});

/** A workspace that only sets properties, such as `data.files`. */
const workspace = (properties: Record<string, string>) =>
  `workspace {
    properties {
${Object.entries(properties)
  .map(([k, v]) => `        "${k}" "${v}"`)
  .join("\n")}
    }
    model {
    }
}
`;

test("data.files steers the readers to a Rails app in a folder, and SQL off its usual paths", async () => {
  const repo = tempRepo();
  repo.write("api/db/schema.rb", schema(""));
  repo.write("api/app/models/item.rb", item(""));
  repo.write("db/tables/keys.sql", keysTable(""));
  const unsteered = repo.commit("monorepo");
  assert.equal((await buildData(repo.root, null, unsteered)).status, "none");

  repo.write(
    "architecture/workspace.dsl",
    workspace({ "data.files": "api/db/schema.rb api/app/models/**/*.rb" }),
  );
  const steered = repo.commit("steer Rails");
  repo.write("api/db/schema.rb", schema(`    t.string "colour"`));
  const rails = await buildData(repo.root, steered, repo.commit("colour"));
  assert.equal(rails.source, "rails");
  assert.deepEqual(
    rails.entities.map((e) => [e.name, e.state, e.file]),
    [
      ["Item", "changed", "api/app/models/item.rb"],
      ["Space", "same", null],
    ],
  );

  repo.write(
    "architecture/workspace.dsl",
    workspace({ "data.files": "db/tables/*.sql" }),
  );
  const sql = await buildData(repo.root, null, repo.commit("steer SQL"));
  assert.equal(sql.source, "sql");
});

test("data.files in the local model steers when the repo commits none", async () => {
  const repo = tempRepo();
  repo.write("db/tables/keys.sql", keysTable(""));
  const head = repo.commit("tables");
  assert.equal((await buildData(repo.root, null, head)).status, "none");
  const file = await localModelFile(repo.root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, workspace({ "data.files": "db/tables/*.sql" }));
  try {
    assert.equal((await buildData(repo.root, null, head)).source, "sql");
  } finally {
    rmSync(file);
  }
});

test("the head's steer reads both ends, so a commit that adds it shows only its own change", async () => {
  const repo = tempRepo();
  repo.write("db/tables/keys.sql", keysTable(""));
  repo.write("db/schema.sql", "CREATE TABLE stray (id int);");
  const base = repo.commit("tables");
  repo.write("db/tables/keys.sql", keysTable("  `prefix` varchar(8),"));
  repo.write(
    "architecture/workspace.dsl",
    workspace({ "data.files": "db/tables/*.sql" }),
  );
  const head = repo.commit("steer, and a column");
  const data = await buildData(repo.root, base, head);
  assert.equal(data.baseModel, true);
  assert.deepEqual(
    data.entities.map((e) => [e.name, e.state]),
    [["Key", "changed"]],
  );
  assert.deepEqual(
    data.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => [f.state, f.item.name]),
    [["added", "prefix"]],
  );
});

test("data.format picks the reader, and an unknown one names the formats Backstory reads", async () => {
  const repo = tempRepo();
  repo.write("db/schema.rb", schema(""));
  repo.write("db/structure.sql", keysTable(""));
  repo.write("architecture/workspace.dsl", workspace({ "data.format": "sql" }));
  const sql = await buildData(repo.root, null, repo.commit("sql"));
  assert.equal(sql.source, "sql");

  repo.write(
    "architecture/workspace.dsl",
    workspace({ "data.format": "prisma" }),
  );
  const unknown = await buildData(repo.root, null, repo.commit("prisma"));
  assert.equal(unknown.status, "none");
  assert.equal(
    unknown.error,
    'data.format says "prisma"; Backstory reads rails, core data and sql',
  );
  assert.equal(unknown.draft, undefined);
});

test("a repo with both schema.rb and structure.sql reads Rails, the earlier reader", async () => {
  const repo = tempRepo();
  repo.write("db/schema.rb", schema(""));
  repo.write("db/structure.sql", "CREATE TABLE items (id bigint NOT NULL);");
  const head = repo.commit("both");
  const data = await buildData(repo.root, null, head);
  assert.equal(data.source, "rails");
});

test("a repo with both Rails and Core Data reads Rails, the first reader", async () => {
  const repo = tempRepo();
  repo.write("db/schema.rb", schema(""));
  repo.write("app/models/item.rb", item(""));
  repo.write("App.xcdatamodeld/App.xcdatamodel/contents", coreData);
  const head = repo.commit("both");
  const data = await buildData(repo.root, null, head);
  assert.equal(data.status, "ok");
  assert.equal(data.source, "rails");
  assert.equal(data.label, "db/schema.rb and the models");
});

test("Core Data reads through the reader list", async () => {
  const repo = tempRepo();
  repo.write("App.xcdatamodeld/App.xcdatamodel/contents", coreData);
  const base = repo.commit("base");
  repo.write(
    "App.xcdatamodeld/App.xcdatamodel/contents",
    coreData.replace(
      "</entity>",
      `    <attribute name="reps" attributeType="Integer 64"/>\n    </entity>`,
    ),
  );
  const head = repo.commit("head");
  const data = await buildData(repo.root, base, head);
  assert.equal(data.source, "core data");
  assert.deepEqual(
    data.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => [f.state, f.item.name]),
    [["added", "reps"]],
  );
});

const field = (name: string) => ({ name, type: "string", required: true });
const entity = (name: string, fields: string[]): Entity => ({
  name,
  file: "lib/notes.ts",
  fields: fields.map(field),
  relationships: [],
  constraints: [],
});
const noteHead: DraftedHead = {
  storage: "JSON files in the home directory",
  entities: [entity("Note", ["id", "body", "rev"])],
};
const noteDelta: DraftedDelta = {
  changed: [entity("Note", ["id", "body"])],
  absent: [],
};

/**
 * A stand-in for the AI provider: the recorded head model and delta, after
 * failing `failures` times. `calls` says which reads it was asked for.
 */
function recorder(
  opts: { head?: DraftedHead; delta?: DraftedDelta; failures?: number } = {},
) {
  const calls: ("head" | "delta")[] = [];
  const prompts: string[] = [];
  let failures = opts.failures ?? 0;
  const runner: Runner = async <T>(prompt: string) => {
    const kind = prompt.includes("The patch:") ? "delta" : "head";
    calls.push(kind);
    prompts.push(prompt);
    if (failures-- > 0) throw new Error("Claude Code failed: blocked");
    const output =
      kind === "head" ? (opts.head ?? noteHead) : (opts.delta ?? noteDelta);
    return { output: output as T, costUsd: 0.1, model: "test-model" };
  };
  return { runner, calls, prompts };
}

const ready = async () => "ready" as const;

/** A TypeScript repo whose stored Note gains a field in its second commit. */
function notesRepo() {
  const repo = tempRepo();
  repo.write(
    "lib/notes.ts",
    "export interface Note {\n  id: string;\n  body: string;\n}\n",
  );
  const base = repo.commit("Add notes");
  repo.write(
    "lib/notes.ts",
    "export interface Note {\n  id: string;\n  body: string;\n  rev: string;\n}\n",
  );
  const head = repo.commit("Leave notes on commits");
  const view: DataView = { root: repo.root, base, head };
  return { ...repo, base, head, view };
}

async function read(view: DataView, opts: Parameters<typeof startDataRead>[1]) {
  const started = await startDataRead(view, { status: ready, ...opts });
  await dataReadSettled(view);
  return started;
}

test("a repo no reader knows shows its data model change once the AI provider drafts it", async () => {
  const repo = notesRepo();
  const before = await buildData(repo.root, repo.base, repo.head);
  assert.equal(before.status, "none");
  assert.deepEqual(
    before.readers,
    DATA_READERS.map((r) => r.label),
  );
  assert.deepEqual(before.draft, { status: "idle", provider: "Claude Code" });

  const ai = recorder();
  const started = await read(repo.view, { runner: ai.runner });
  assert.equal(started.status, "running");
  assert.deepEqual(ai.calls, ["head", "delta"]);
  const status = await dataStatus(repo.view);
  assert.equal(status.status, "done");

  const data = await buildData(repo.root, repo.base, repo.head);
  assert.equal(data.status, "ok");
  assert.equal(data.source, "drafted");
  assert.deepEqual(data.drafted, {
    provider: "Claude Code",
    model: "test-model",
  });
  assert.equal(data.baseModel, true);
  assert.deepEqual(
    data.entities.map((e) => [e.name, e.state]),
    [["Note", "changed"]],
  );
  assert.deepEqual(
    data.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => [f.state, f.item.name]),
    [["added", "rev"]],
  );
});

test("an empty change reads only the head, and its base is the head", async () => {
  const repo = notesRepo();
  repo.git("commit", "--allow-empty", "-qm", "Nothing");
  const view: DataView = {
    root: repo.root,
    base: repo.head,
    head: repo.git("rev-parse", "HEAD"),
  };
  const ai = recorder();
  await read(view, { runner: ai.runner });
  assert.deepEqual(ai.calls, ["head"]);
  assert.equal((await dataStatus(view)).status, "done");

  const data = await buildData(repo.root, view.base, view.head);
  assert.equal(data.status, "ok");
  assert.equal(data.baseModel, true);
  assert.deepEqual(data.entities, []);
});

test("a delta merges onto the head: changed replaces, absent removes, new ones join", () => {
  const head = [
    entity("Note", ["id", "rev"]),
    entity("Round", ["id"]),
    entity("Recent", ["path"]),
  ];
  const merged = mergeDelta(head, {
    changed: [entity("Note", ["id"]), entity("Outbox", ["id"])],
    absent: ["Round"],
  });
  assert.deepEqual(
    merged.map((e) => [e.name, e.fields.map((f) => f.name)]),
    [
      ["Note", ["id"]],
      ["Recent", ["path"]],
      ["Outbox", ["id"]],
    ],
  );
  assert.equal(merged[1], head[2]);
});

test("the drafted model is cached by tree, so a reworded head reads nothing again", async () => {
  const repo = notesRepo();
  await read(repo.view, { runner: recorder().runner });
  repo.git("commit", "--amend", "-qm", "Reworded");
  const head = repo.git("rev-parse", "HEAD");
  assert.notEqual(head, repo.head);

  const again = recorder();
  await read({ ...repo.view, head }, { runner: again.runner });
  assert.deepEqual(again.calls, []);
  const data = await buildData(repo.root, repo.base, head);
  assert.equal(data.source, "drafted");
});

test("a view whose head is cached reads only the delta", async () => {
  const repo = notesRepo();
  repo.write("README.md", "notes\n");
  const tip = repo.commit("Say what notes are");
  await read(
    { root: repo.root, base: repo.head, head: tip },
    { runner: recorder({ delta: { changed: [], absent: [] } }).runner },
  );

  const ai = recorder();
  await read(
    { root: repo.root, base: repo.base, head: tip },
    { runner: ai.runner },
  );
  assert.deepEqual(ai.calls, ["delta"]);
});

test("a failed run isn't retried, fails with the provider's message and caches nothing", async () => {
  const repo = notesRepo();
  const failing = recorder({ failures: Infinity });
  await read(repo.view, { runner: failing.runner });
  assert.deepEqual(failing.calls, ["head"]);
  assert.deepEqual(await dataStatus(repo.view), {
    status: "failed",
    error: "Claude Code failed: blocked",
  });
  assert.equal(
    (await buildData(repo.root, repo.base, repo.head)).status,
    "none",
  );

  const next = recorder();
  await read(repo.view, { runner: next.runner });
  assert.deepEqual(next.calls, ["head", "delta"]);
});

test("a provider that isn't installed says which, and reads nothing", async () => {
  const repo = notesRepo();
  const ai = recorder();
  const status = await startDataRead(repo.view, {
    runner: ai.runner,
    status: async () => "missing",
  });
  assert.deepEqual(status, {
    status: "unavailable",
    provider: "Claude Code",
    reason: "no-claude",
  });
  assert.deepEqual(ai.calls, []);
  assert.deepEqual(await dataStatus(repo.view), status);
});

test("a logged-out provider says so, and reads nothing", async () => {
  const repo = notesRepo();
  const ai = recorder();
  const status = await startDataRead(repo.view, {
    runner: ai.runner,
    status: async () => "logged-out",
  });
  assert.deepEqual(status, {
    status: "unavailable",
    provider: "Claude Code",
    reason: "logged-out",
  });
  assert.deepEqual(ai.calls, []);
});

test("a patch past the cap fails as too large and reads nothing", async () => {
  const repo = notesRepo();
  repo.write("big.txt", `${"x".repeat(99)}\n`.repeat(5000));
  const head = repo.commit("Add a big file");
  const view = { root: repo.root, base: repo.head, head };
  const ai = recorder();
  await read(view, { runner: ai.runner });
  assert.deepEqual(ai.calls, []);
  assert.deepEqual(await dataStatus(view), {
    status: "failed",
    error: TOO_LARGE,
  });
});

test("a root commit reads only the head, with no base model", async () => {
  const repo = notesRepo();
  const root = repo.git("rev-list", "--max-parents=0", "HEAD");
  const view = { root: repo.root, base: null, head: root };
  const ai = recorder();
  await read(view, { runner: ai.runner });
  assert.deepEqual(ai.calls, ["head"]);
  const data = await buildData(repo.root, null, root);
  assert.equal(data.status, "ok");
  assert.equal(data.baseModel, false);
});

test("redraft reads again and replaces the files, and a failed redraft keeps them", async () => {
  const repo = notesRepo();
  await read(repo.view, { runner: recorder().runner });

  const failing = recorder({ failures: Infinity });
  await read(repo.view, { runner: failing.runner, redraft: true });
  assert.deepEqual(failing.calls, ["head"]);
  assert.equal((await dataStatus(repo.view)).status, "failed");
  const kept = await buildData(repo.root, repo.base, repo.head);
  assert.deepEqual(
    kept.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => f.item.name),
    ["rev"],
  );

  const again = recorder({
    head: {
      ...noteHead,
      entities: [entity("Note", ["id", "body", "rev", "author"])],
    },
  });
  await read(repo.view, { runner: again.runner, redraft: true });
  assert.deepEqual(again.calls, ["head", "delta"]);
  const redrafted = await buildData(repo.root, repo.base, repo.head);
  assert.deepEqual(
    redrafted.entities[0].fields
      .filter((f) => f.state !== "same")
      .map((f) => f.item.name),
    ["rev", "author"],
  );
});

test("data.files tells the drafted read where the model is, and a changed steer reads the head again", async () => {
  const repo = notesRepo();
  const file = await localModelFile(repo.root);
  mkdirSync(path.dirname(file), { recursive: true });
  const steer = (files: string) =>
    writeFileSync(file, workspace({ "data.files": files }));
  try {
    steer("lib/**/*.ts");
    const ai = recorder();
    await read({ ...repo.view, files: ["lib/**/*.ts"] }, { runner: ai.runner });
    assert.deepEqual(ai.calls, ["head", "delta"]);
    assert.equal(ai.prompts.length, 2);
    for (const prompt of ai.prompts)
      assert.match(
        prompt,
        /declared in the files matching these globs: lib\/\*\*\/\*\.ts\./,
      );
    const drafted = await buildData(repo.root, repo.base, repo.head);
    assert.equal(drafted.source, "drafted");

    steer("lib/notes.ts");
    const stale = await buildData(repo.root, repo.base, repo.head);
    assert.equal(stale.status, "none");
    assert.deepEqual(stale.draft, { status: "idle", provider: "Claude Code" });

    const again = recorder();
    await read(
      { ...repo.view, files: ["lib/notes.ts"] },
      { runner: again.runner },
    );
    assert.deepEqual(again.calls, ["head", "delta"]);
    assert.equal(
      (await buildData(repo.root, repo.base, repo.head)).source,
      "drafted",
    );
  } finally {
    rmSync(file);
  }
});
