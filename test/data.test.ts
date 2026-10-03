import assert from "node:assert/strict";
import { test } from "node:test";

import { readCoreData } from "../lib/data/coredata";
import { diffModels } from "../lib/data/diff";
import { readRails, tableFor } from "../lib/data/rails";

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
    schema: schema(`    t.integer "zoom_import_status"\n    t.index ["space_id", "zoom_meeting_uuid"], name: "x", unique: true`),
    models: new Map([
      ["app/models/item.rb", item(`  enum :zoom_import_status, {import_pending: 0, import_complete: 1}`)],
      ["app/models/space.rb", space],
    ]),
  });
  const it = model.entities.get("Item")!;
  assert.equal(it.file, "app/models/item.rb");
  assert.deepEqual(it.fields.find((f) => f.name === "title"), { name: "title", type: "string", required: true });
  assert.deepEqual(it.fields.find((f) => f.name === "zoom_import_status")?.values, ["import_pending", "import_complete"]);
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
    models: new Map([["app/models/item.rb", item(`  belongs_to :source, polymorphic: true, optional: true`)]]),
  });
  const source = model.entities.get("Item")!.relationships.find((r) => r.name === "source");
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
      ["app/models/item.rb", `class Item < ApplicationRecord\n  belongs_to :source, polymorphic: true\nend\n`],
      [
        "app/models/zoom/recording.rb",
        `module Zoom\n  class Recording < ApplicationRecord\n    has_one :item, as: :source\n  end\nend\n`,
      ],
    ]),
  });
  assert.deepEqual(model.entities.get("Item")!.relationships[0].candidates, ["Zoom::Recording"]);
  assert.equal(model.entities.get("Zoom::Recording")!.relationships[0].as, "source");
});

test("the diff names what changed on each entity, with neighbours after", () => {
  const before = readRails({ schema: schema(""), models: new Map([["app/models/item.rb", item("")], ["app/models/space.rb", space]]) });
  const after = readRails({
    schema: schema(`    t.string "zoom_meeting_uuid"`),
    models: new Map([["app/models/item.rb", item("")], ["app/models/space.rb", space]]),
  });
  const diff = diffModels(before, after);
  assert.deepEqual(diff.map((e) => [e.name, e.state]), [
    ["Item", "changed"],
    ["Space", "same"],
  ]);
  assert.deepEqual(
    diff[0].fields.filter((f) => f.state !== "same").map((f) => [f.state, f.item.name]),
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
  assert.deepEqual(m.relationships[0], { name: "exercises", kind: "has many", target: "Exercise", polymorphic: false });
  assert.deepEqual(m.constraints, [{ kind: "unique", fields: ["id"] }]);
  assert.equal(model.entities.get("Exercise")!.relationships[0].kind, "belongs to");
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
      ["app/models/item.rb", `class Item < ApplicationRecord\n  belongs_to :source, polymorphic: true\nend\n`],
      ["app/models/space.rb", `class Space < ApplicationRecord\n  has_many :zoom_recordings, class_name: "Zoom::Recording"\nend\n`],
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
  assert.deepEqual(by("Zoom::Recording").fields.map((f) => f.item.name), ["meeting_uuid"]);
  assert.deepEqual(by("Zoom::Recording").details.timestamps.map((f) => f.item.name), ["created_at"]);
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
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const repo = mkdtempSync(path.join(os.tmpdir(), "differ-unicode-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  const write = (f: string, t: string) => {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), t);
  };
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    write("db/schema.rb", `ActiveRecord::Schema[8.1].define(version: 1) do\n  create_table "items", force: :cascade do |t|\n    t.string "title"\n  end\n  create_table "posts", force: :cascade do |t|\n    t.string "title"\n  end\nend\n`);
    // An em-dash-heavy comment, as real code has, before a later model.
    write("app/models/item.rb", `# ${"— ".repeat(60)}\nclass Item < ApplicationRecord\nend\n`);
    write("app/models/post.rb", `class Post < ApplicationRecord\n  belongs_to :item\nend\n`);
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write("app/models/post.rb", `class Post < ApplicationRecord\n  belongs_to :item\n  has_many :comments\nend\n`);
    git("commit", "-qam", "head");
    const data = await buildData(repo, base, git("rev-parse", "HEAD"));
    const post = data.entities.find((e) => e.name === "Post")!;
    assert.deepEqual(
      post.relationships.filter((r) => r.state !== "same").map((r) => [r.state, r.item.name]),
      [["added", "comments"]],
    );
    assert.equal(data.entities.find((e) => e.name === "Item")?.state ?? "same", "same");
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
      ["app/models/purchase.rb", `class Purchase < ApplicationRecord\n  belongs_to :buyer, class_name: 'Person'\n  enum :role, [:creator, :member]\nend\n`],
      ["app/models/person.rb", `class Person < ApplicationRecord\n  has_many :purchases, foreign_key: :buyer_id\nend\n`],
      ["app/models/access_grant.rb", `class AccessGrant < ApplicationRecord\n  belongs_to :purchase\nend\n`],
    ]),
  });
  assert.ok(model.entities.has("Person"), "people is Person's table");
  assert.equal(model.entities.get("Person")!.relationships[0].target, "Purchase");
  assert.equal(model.entities.get("Purchase")!.relationships[0].target, "Person");
  assert.deepEqual(model.entities.get("Purchase")!.fields[0].values, ["creator", "member"]);
  const fk = model.entities.get("AccessGrant")!.constraints.find((c) => c.kind === "foreign key");
  assert.deepEqual(fk, { kind: "foreign key", fields: ["purchase_id"], target: "Purchase" });
});

test("an explicit class_name wins over a target guessed from source:", () => {
  const model = readRails({
    schema: `ActiveRecord::Schema[8.1].define(version: 1) do\n  create_table "spaces", force: :cascade do |t|\n  end\nend\n`,
    models: new Map([
      ["app/models/space.rb", `class Space < ApplicationRecord\n  has_many :members, through: :memberships, source: :owner, class_name: "User"\nend\n`],
    ]),
  });
  assert.equal(model.entities.get("Space")!.relationships[0].target, "User");
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
    ["app/models/item.rb", `class Item < ApplicationRecord\n  belongs_to :space\nend\n`],
    ["app/models/space.rb", `class Space < ApplicationRecord\n  has_many :items\nend\n`],
  ]);
  const before = readRails({ schema: schema(`t.bigint "space_id"`, ""), models });
  const notNull = readRails({ schema: schema(`t.bigint "space_id", null: false`, ""), models });
  const withFk = readRails({ schema: schema(`t.bigint "space_id"`, `add_foreign_key "items", "spaces"`), models });

  const tightened = present(diffModels(before, notNull)).find((p) => p.entity.name === "Item")!;
  assert.equal(tightened.state, "changed");
  assert.deepEqual(tightened.fields.map((f) => f.item.name), ["space_id"]);

  const constrained = present(diffModels(before, withFk)).find((p) => p.entity.name === "Item")!;
  assert.equal(constrained.state, "changed");
  assert.equal(constrained.summary, "+1 rule");
});
