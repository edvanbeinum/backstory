import type { Constraint, DataModel, Entity, Field, Relationship, RelationshipKind } from "./types";

/**
 * Rails's data model: fields and constraints from `db/schema.rb`, which
 * Rails writes from the database, and relationships and enums from the
 * models' declarations. Read as text; nothing is loaded or run.
 */

export interface RailsSources {
  schema: string;
  /** Model files' contents, by path */
  models: Map<string, string>;
}

/** "Zoom::Recording" → "zoom_recordings"; "Category" → "categories". */
export function tableFor(className: string): string {
  const snake = className
    .split("::")
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join("_");
  return pluralise(snake);
}

/** Plurals Rails's inflector knows that suffix rules get wrong. */
const IRREGULAR: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  status: "statuses",
  alias: "aliases",
  address: "addresses",
  datum: "data",
  medium: "media",
  analysis: "analyses",
};
const SINGULAR = Object.fromEntries(Object.entries(IRREGULAR).map(([one, many]) => [many, one]));

/** Inflect the last word of a snake_case name: "access_grant" → "access_grants". */
function lastWord(word: string, fn: (w: string) => string) {
  const at = word.lastIndexOf("_");
  return at === -1 ? fn(word) : word.slice(0, at + 1) + fn(word.slice(at + 1));
}

function pluralise(name: string): string {
  return lastWord(name, pluralWord);
}

function pluralWord(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  return word + "s";
}

function parseSchema(schema: string) {
  const tables = new Map<string, { fields: Field[]; constraints: Constraint[] }>();
  const foreignKeys: { from: string; to: string; column: string }[] = [];
  let current: { fields: Field[]; constraints: Constraint[] } | null = null;

  for (const raw of schema.split("\n")) {
    const line = raw.trim();
    const table = line.match(/^create_table "([^"]+)"/);
    if (table) {
      current = { fields: [], constraints: [] };
      tables.set(table[1], current);
      continue;
    }
    if (line === "end") {
      current = null;
      continue;
    }
    const fk = line.match(/^add_foreign_key "([^"]+)", "([^"]+)"(?:.*column: "([^"]+)")?/);
    if (fk) {
      foreignKeys.push({ from: fk[1], to: fk[2], column: fk[3] ?? "" });
      continue;
    }
    if (!current) continue;

    const column = line.match(/^t\.(\w+) "([^"]+)"(.*)$/);
    if (column) {
      current.fields.push({
        name: column[2],
        type: column[1],
        required: /null: false/.test(column[3]),
      });
      continue;
    }
    // A unique index or constraint is a rule about the data; a plain index
    // is a performance detail and stays out of the view.
    const unique = line.match(/^t\.(?:index|unique_constraint) \[([^\]]+)\](.*)$/);
    if (unique && (/unique: true/.test(unique[2]) || line.startsWith("t.unique_constraint"))) {
      current.constraints.push({
        kind: "unique",
        fields: unique[1].split(",").map((f) => f.trim().replace(/"/g, "")),
      });
    }
  }
  return { tables, foreignKeys };
}

interface ModelDecl {
  name: string;
  file: string;
  table: string;
  relationships: Relationship[];
  enums: Map<string, string[]>;
}

const KINDS: Record<string, RelationshipKind> = {
  belongs_to: "belongs to",
  has_many: "has many",
  has_one: "has one",
  has_and_belongs_to_many: "many to many",
};

function classify(name: string) {
  return name
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function singular(name: string) {
  return lastWord(name, singularWord);
}

/**
 * "purchases" → "purchase", "boxes" → "box", "categories" → "category".
 * Only -sses, -xes, -zes, -ches and -shes lose "es": "purchases" is a
 * purchase plus "s", not a "purchas".
 */
function singularWord(word: string) {
  if (SINGULAR[word]) return SINGULAR[word];
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(sses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** An option's string value, in either quote style: class_name: 'User'. */
const quoted = (opts: string, key: string) =>
  opts.match(new RegExp(`${key}:\\s*["']([^"']+)["']`))?.[1];

function parseModel(file: string, text: string): ModelDecl | null {
  // The file's record class: `class Zoom::Recording < ApplicationRecord`, or
  // a class nested in `module Zoom`.
  const modules: string[] = [];
  let name: string | null = null;
  for (const line of text.split("\n")) {
    const mod = line.match(/^\s*module (\w+(?:::\w+)*)/);
    if (mod && !name) modules.push(mod[1]);
    const cls = line.match(/^\s*class (\w+(?:::\w+)*)\s*<\s*(\w+(?:::\w+)*)/);
    if (cls && /Record$|^ActiveRecord::Base$/.test(cls[2])) {
      name = [...modules, cls[1]].join("::");
      break;
    }
  }
  if (!name) return null;

  const table = text.match(/self\.table_name\s*=\s*["']([^"']+)["']/)?.[1] ?? tableFor(name);
  const relationships: Relationship[] = [];
  const enums = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const rel = line.match(/^\s*(belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:(\w+)(.*)$/);
    if (rel) {
      const opts = rel[3];
      const polymorphic = /polymorphic:\s*true/.test(opts);
      const className = quoted(opts, "class_name");
      const through = opts.match(/through:\s*:(\w+)/)?.[1];
      const as = opts.match(/\bas:\s*:(\w+)/)?.[1];
      const foreignKey = opts.match(/foreign_key:\s*:?"?(\w+)"?/)?.[1];
      // A through association can name the association it follows (source:)
      // and, when that's polymorphic, the type it lands on (source_type:).
      const sourceType = quoted(opts, "source_type");
      const sourceName = opts.match(/\bsource:\s*:(\w+)/)?.[1];
      const source = sourceType ?? (sourceName ? classify(singular(sourceName)) : undefined);
      const base = rel[1] === "belongs_to" || rel[1] === "has_one" ? rel[2] : singular(rel[2]);
      relationships.push({
        name: rel[2],
        kind: KINDS[rel[1]],
        target: polymorphic ? null : (source ?? className ?? classify(base)),
        polymorphic,
        ...(as ? { as } : {}),
        ...(through ? { through } : {}),
        // A belongs-to lives in this entity's own columns.
        ...(rel[1] === "belongs_to"
          ? { fields: [...(polymorphic ? [`${rel[2]}_type`] : []), foreignKey ?? `${rel[2]}_id`] }
          : {}),
      });
      continue;
    }
    // enum :status, {a: 0, b: 1} · enum status: {a: 0} · enum :role, [:a, :b]
    const en = line.match(/^\s*enum\s+:?(\w+):?,?\s*([{[])([^}\]]*)[}\]]/);
    if (en) {
      const values =
        en[2] === "{"
          ? [...en[3].matchAll(/["']?(\w+)["']?\s*:/g)].map((m) => m[1])
          : [...en[3].matchAll(/:(\w+)|["'](\w+)["']/g)].map((m) => m[1] ?? m[2]);
      enums.set(en[1], values);
    }
  }
  return { name, file, table, relationships, enums };
}

export function readRails(src: RailsSources): DataModel {
  const { tables, foreignKeys } = parseSchema(src.schema);
  const models = [...src.models]
    .map(([file, text]) => parseModel(file, text))
    .filter((m): m is ModelDecl => m !== null);
  const byTable = new Map(models.map((m) => [m.table, m]));

  const entities = new Map<string, Entity>();
  for (const [table, t] of tables) {
    const model = byTable.get(table);
    const name = model?.name ?? classify(singular(table));
    const fields = t.fields.map((f) => {
      const values = model?.enums.get(f.name);
      return values ? { ...f, type: "enum", values } : f;
    });
    const constraints: Constraint[] = [
      ...t.constraints,
      ...foreignKeys
        .filter((fk) => fk.from === table)
        .map((fk) => ({
          kind: "foreign key" as const,
          fields: [fk.column || `${singular(fk.to)}_id`],
          target: byTable.get(fk.to)?.name ?? classify(singular(fk.to)),
        })),
    ];
    entities.set(name, {
      name,
      file: model?.file ?? null,
      fields,
      relationships: model?.relationships ?? [],
      constraints,
    });
  }
  // "Any" in a polymorphic belongs-to means the entities that say they're
  // one: `has_one :item, as: :source` on Zoom::Recording fills Item.source.
  for (const entity of entities.values()) {
    for (const rel of entity.relationships) {
      if (!rel.polymorphic || rel.kind !== "belongs to") continue;
      rel.candidates = [...entities.values()]
        .filter((other) =>
          other.relationships.some((r) => r.as === rel.name && r.target === entity.name),
        )
        .map((other) => other.name)
        .sort();
    }
  }
  return { source: "rails", entities };
}
