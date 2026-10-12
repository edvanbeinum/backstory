import picomatch from "picomatch";

import { classify, readFiles, singular } from "./rails";
import type { DataReader } from "./readers";
import type { Constraint, DataModel, Entity, Field } from "./types";

/**
 * A data model written as SQL `CREATE TABLE` statements: a `schema.sql`,
 * Rails's `structure.sql`, a pg_dump, or a folder of table files beside an
 * ORM. Read as text; nothing is run and no database is involved. Statements
 * it doesn't know are skipped rather than guessed at.
 */

const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;

/** The parts of `schema.name`, without their quotes. */
const parts = (name: string) =>
  (name.match(new RegExp(NAME, "g")) ?? [name]).map((p) =>
    p.replace(/^["`[]|["`\]]$/g, ""),
  );

/** The last part of `schema.name`, without its quotes. */
const bare = (name: string) => parts(name).at(-1) ?? name;

/** `schema.name` without its quotes or spaces: a table's key. */
const qualified = (name: string) => parts(name).join(".");
const unqualified = (key: string) => key.slice(key.lastIndexOf(".") + 1);

/** The text's statements, split on `;` outside quotes, with comments gone. */
export function statements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === "'") current += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      current += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      current += " ";
      continue;
    }
    if (c === ";") {
      out.push(current.trim());
      current = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "[") quote = "]";
    current += c;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** Splits on commas outside parentheses and quotes: `numeric(10, 2)` stays whole. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === "'") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** The text inside the parentheses that open at `open`, and what follows them. */
function parenthesised(text: string, open: number) {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === "'") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0)
      return { inner: text.slice(open + 1, i), rest: text.slice(i + 1) };
  }
  return { inner: text.slice(open + 1), rest: "" };
}

/**
 * Index columns: a name, or an expression such as `lower(email)` as written.
 * A name may carry MySQL's prefix length, `email(191)`; any other parenthesis
 * makes it a function call.
 */
const columns = (list: string) =>
  splitTop(list).map((c) => {
    const name = c.match(
      new RegExp(`^(${NAME})(?:\\s*\\(\\s*\\d+\\s*\\))?(?:\\s|$)`),
    )?.[1];
    return name ? bare(name) : c.toLowerCase();
  });

const strings = (text: string) =>
  [...text.matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map((m) =>
    m[1].replace(/''/g, "'"),
  );

interface Table {
  /** As qualified as it was declared: `audit.users` and `public.users` are two tables */
  name: string;
  file: string;
  fields: Field[];
  /** Columns that hold a reference, and the table each points at */
  foreignKeys: { fields: string[]; table: string }[];
  unique: string[][];
}

type Rule =
  | { kind: "unique"; fields: string[] }
  | { kind: "foreign key"; fields: string[]; table: string }
  /** Not shown as a rule, but its fields can't be null */
  | { kind: "primary key"; fields: string[] }
  /** A plain index, a check: nothing the data view shows */
  | { kind: "skip" };

/**
 * A plain index (`KEY idx (a)`), told from a column named `key` by what its
 * parentheses hold: column names, not a length such as `varchar(256)`.
 */
const INDEX = new RegExp(
  String.raw`^(?:(?:fulltext|spatial)\s+)?(?:key|index)\b\s*(?:${NAME}\s*)?\(\s*[A-Za-z_"\x60[]`,
  "i",
);

/** A table-level rule, or null when the item is a column. */
function rule(item: string): Rule | null {
  const text = item.replace(new RegExp(`^constraint\\s+${NAME}\\s*`, "i"), "");
  const unique = text.match(
    new RegExp(
      `^unique\\b(?:\\s+(?:key|index))?(?:\\s+nulls\\s+(?:not\\s+)?distinct)?\\s*(?:${NAME}\\s*)?\\(`,
      "i",
    ),
  );
  if (unique) {
    const { inner } = parenthesised(text, unique[0].length - 1);
    return { kind: "unique", fields: columns(inner) };
  }
  const foreign = text.match(
    new RegExp(`^foreign\\s+key\\s*(?:${NAME}\\s*)?\\(`, "i"),
  );
  if (foreign) {
    const { inner, rest } = parenthesised(text, foreign[0].length - 1);
    const to = rest.match(new RegExp(`^\\s*references\\s+(${QUALIFIED})`, "i"));
    return to
      ? { kind: "foreign key", fields: columns(inner), table: qualified(to[1]) }
      : { kind: "skip" };
  }
  const primary = text.match(/^primary\s+key\s*\(/i);
  if (primary) {
    const { inner } = parenthesised(text, primary[0].length - 1);
    return { kind: "primary key", fields: columns(inner) };
  }
  // A named constraint that is none of these, such as a check.
  if (text !== item) return { kind: "skip" };
  if (
    INDEX.test(text) ||
    /^(?:primary\s+key|check\s*\(|exclude\s+(?:using\b|\()|period\s+for\b)/i.test(
      text,
    )
  )
    return { kind: "skip" };
  return null;
}

/** Words that end a column's type and start its options. */
const OPTIONS =
  "not|null|primary|unique|references|default|constraint|check|collate|generated|auto_increment|autoincrement|comment|character|charset|on|identity|as|invisible|visible";
const TYPE = new RegExp(
  String.raw`^(${QUALIFIED}(?:\s*\([^)]*\))?(?:\s*\[\])*(?:\s+(?!(?:${OPTIONS})\b)[\w$]+(?:\s*\([^)]*\))?(?:\s*\[\])*)*)`,
  "i",
);

function column(
  item: string,
  table: Table,
  enums: Map<string, string[]>,
): void {
  const head = item.match(new RegExp(`^(${NAME})\\s+`));
  if (!head) return;
  const name = bare(head[1]);
  const rest = item.slice(head[0].length);
  const written = rest.match(TYPE)?.[1];
  if (!written) return;
  const options = rest
    .slice(written.length)
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
  const type = written.replace(/["`]/g, "").replace(/\s+/g, " ").toLowerCase();

  const field: Field = {
    name,
    type,
    required: /\bnot\s+null\b|\bprimary\s+key\b/i.test(options),
  };
  if (/^enum\s*\(/.test(type)) {
    field.type = "enum";
    field.values = strings(written);
  } else {
    const values = enums.get(bare(type));
    if (values) field.values = values;
  }
  table.fields.push(field);

  if (/\bunique\b/i.test(options)) table.unique.push([name]);
  const to = options.match(new RegExp(`\\breferences\\s+(${QUALIFIED})`, "i"));
  if (to) table.foreignKeys.push({ fields: [name], table: qualified(to[1]) });
}

function apply(table: Table, r: Rule) {
  if (r.kind === "primary key")
    for (const f of table.fields)
      if (r.fields.includes(f.name)) f.required = true;
  if (r.kind === "unique") table.unique.push(r.fields);
  if (r.kind === "foreign key")
    table.foreignKeys.push({ fields: r.fields, table: r.table });
}

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})\s*\(`,
  "i",
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+([\s\S]*)$`,
  "i",
);
const UNIQUE_INDEX = new RegExp(
  String.raw`^create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${QUALIFIED}\s+)?on\s+(?:only\s+)?(${QUALIFIED})\s*(?:using\s+\w+\s*)?\(`,
  "i",
);
const ENUM_TYPE = new RegExp(
  String.raw`^create\s+type\s+(${QUALIFIED})\s+as\s+enum\s*\(([\s\S]*)\)$`,
  "i",
);

const entityName = (table: string) => classify(singular(table));

/** The data model the files declare, files read in path order. */
export function readSql(files: Map<string, string>): DataModel {
  const parsed = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, text]) => ({ file, statements: statements(text) }));

  // Types first: a column can use an enum declared after it, or in another file.
  const enums = new Map<string, string[]>();
  for (const { statements: list } of parsed)
    for (const s of list) {
      const en = s.match(ENUM_TYPE);
      if (en) enums.set(bare(en[1]).toLowerCase(), strings(en[2]));
    }

  const tables = new Map<string, Table>();
  const later: { table: string; rule: Rule }[] = [];
  for (const { file, statements: list } of parsed) {
    for (const s of list) {
      const create = s.match(CREATE_TABLE);
      if (create) {
        const name = qualified(create[1]);
        if (tables.has(name)) continue;
        const table: Table = {
          name,
          file,
          fields: [],
          foreignKeys: [],
          unique: [],
        };
        const { inner } = parenthesised(s, create[0].length - 1);
        // Apply rules after the columns: a primary key may come before the fields it requires.
        const rules: Rule[] = [];
        for (const item of splitTop(inner)) {
          const r = rule(item);
          if (r) rules.push(r);
          else column(item, table, enums);
        }
        for (const r of rules) apply(table, r);
        tables.set(name, table);
        continue;
      }
      const alter = s.match(ALTER_TABLE);
      if (alter) {
        for (const action of splitTop(alter[2])) {
          const add = action.match(/^add\s+(?!column\b)/i);
          const r = add ? rule(action.slice(add[0].length)) : null;
          if (r) later.push({ table: qualified(alter[1]), rule: r });
        }
        continue;
      }
      const index = s.match(UNIQUE_INDEX);
      if (index) {
        const { inner } = parenthesised(s, index[0].length - 1);
        later.push({
          table: qualified(index[1]),
          rule: { kind: "unique", fields: columns(inner) },
        });
      }
    }
  }
  // Match a reference by its qualified name, else by its bare one: pg_dump
  // qualifies every name, but a hand-written file may qualify only some.
  const resolve = (ref: string) =>
    tables.get(ref) ??
    [...tables.values()].find((t) => unqualified(t.name) === unqualified(ref));
  for (const { table, rule: r } of later) {
    const t = resolve(table);
    if (t) apply(t, r);
  }

  // Name an entity after its bare table, and a later table whose bare name
  // is taken after its schema too: `audit.users` beside `public.users` is AuditUser.
  const names = new Map<Table, string>();
  const taken = new Set<string>();
  for (const t of tables.values()) {
    let name = entityName(unqualified(t.name));
    if (taken.has(name)) name = entityName(t.name.replace(/\./g, "_"));
    names.set(t, name);
    taken.add(name);
  }
  const target = (ref: string) => {
    const t = resolve(ref);
    return (t && names.get(t)) ?? entityName(unqualified(ref));
  };

  const entities = new Map<string, Entity>();
  for (const [t, name] of names) {
    const constraints: Constraint[] = [
      ...t.unique.map((fields) => ({ kind: "unique" as const, fields })),
      ...t.foreignKeys.map((fk) => ({
        kind: "foreign key" as const,
        fields: fk.fields,
        target: target(fk.table),
      })),
    ];
    entities.set(name, {
      name,
      file: t.file,
      fields: t.fields,
      relationships: t.foreignKeys.map((fk) => ({
        name: fk.fields[0].replace(/(?:_id|(?<=[a-z])Id)$/, ""),
        kind: "belongs to" as const,
        target: target(fk.table),
        polymorphic: false,
        fields: fk.fields,
      })),
      constraints,
    });
  }
  return { source: "sql", entities };
}

/** Where a schema file sits when nothing says otherwise. */
const SCHEMA_PATHS = picomatch(
  ["**/schema.sql", "**/structure.sql", "**/schema/**/*.sql"],
  { dot: true },
);
/** Migrations replay changes rather than declare the model; tests and fixtures declare their own. */
const SKIPPED_FOLDER =
  /(?:^|\/)(?:migrations?|migrate|tests?|spec|specs|fixtures)\//;

export const sqlReader: DataReader = {
  source: "sql",
  label: "SQL schema files",
  async read(at) {
    const paths = (await at.listing()).filter(
      (p) =>
        p.endsWith(".sql") &&
        (at.steered || (SCHEMA_PATHS(p) && !SKIPPED_FOLDER.test(p))),
    );
    if (paths.length === 0) return null;
    // Read every file, not just those with a CREATE TABLE: a schema folder
    // can keep its indexes, foreign keys or enums apart from its tables.
    const model = readSql(await readFiles(at, paths));
    return model.entities.size > 0 ? model : null;
  },
};
