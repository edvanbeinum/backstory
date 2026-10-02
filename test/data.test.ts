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
  assert.deepEqual(source, { name: "source", kind: "belongs to", target: null, polymorphic: true });
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
