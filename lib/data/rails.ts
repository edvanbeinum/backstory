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

function pluralise(word: string): string {
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

function singular(word: string) {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

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

  const table = text.match(/self\.table_name\s*=\s*"([^"]+)"/)?.[1] ?? tableFor(name);
  const relationships: Relationship[] = [];
  const enums = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const rel = line.match(/^\s*(belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:(\w+)(.*)$/);
    if (rel) {
      const opts = rel[3];
      const polymorphic = /polymorphic:\s*true/.test(opts);
      const className = opts.match(/class_name:\s*"([^"]+)"/)?.[1];
      const through = opts.match(/through:\s*:(\w+)/)?.[1];
      const source = opts.match(/source_type:\s*"([^"]+)"/)?.[1];
      const base = rel[1] === "belongs_to" || rel[1] === "has_one" ? rel[2] : singular(rel[2]);
      relationships.push({
        name: rel[2],
        kind: KINDS[rel[1]],
        target: polymorphic ? null : (source ?? className ?? classify(base)),
        polymorphic,
        ...(through ? { through } : {}),
      });
      continue;
    }
    const en = line.match(/^\s*enum\s+:?(\w+):?,?\s*\{([^}]*)\}/);
    if (en) {
      enums.set(
        en[1],
        [...en[2].matchAll(/(\w+):/g)].map((m) => m[1]),
      );
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
  return { source: "rails", entities };
}
