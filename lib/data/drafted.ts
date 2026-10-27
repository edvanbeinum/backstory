import type { AiResult, Runner } from "../ai/provider";
import { git } from "../exec";
import { withSnapshot } from "../flows/generate";
import type { Entity } from "./types";

/**
 * The AI provider's reading of a data model, for a repo no data reader
 * understands. A commit is read in full, or as a delta from a model already
 * read: the provider gets that model and the patch from its commit to this
 * one, and returns only the entities the patch changed. Two independent reads
 * disagree on judgement calls, and the diff would report the disagreement as
 * change; and asked for a whole model again, the provider drops the untouched
 * entities of a large one.
 */

/** Patches past this aren't sent; the commit is read in full instead. */
export const MAX_PATCH_BYTES = 400 * 1024;

export interface DraftedHead {
  /** A short sentence naming the kinds of store the program keeps its records in */
  storage: string;
  entities: Entity[];
}

export interface DraftedDelta {
  /** This commit's version of each entity the patch changed or added */
  changed: Entity[];
  /** Entities of the model the delta starts from that this commit doesn't have */
  absent: string[];
  /** This commit's storage sentence, only when the patch adds or removes a kind of store */
  storage?: string;
}

const fieldSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "required"],
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    required: { type: "boolean" },
    values: { type: "array", items: { type: "string" } },
  },
};
const relationshipSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "target", "polymorphic"],
  properties: {
    name: { type: "string" },
    kind: {
      enum: ["belongs to", "has many", "has one", "many to many", "contains"],
    },
    target: { type: ["string", "null"] },
    polymorphic: { type: "boolean" },
    candidates: { type: "array", items: { type: "string" } },
    fields: { type: "array", items: { type: "string" } },
  },
};
const constraintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "fields"],
  properties: {
    kind: { enum: ["unique", "foreign key"] },
    fields: { type: "array", items: { type: "string" } },
    target: { type: "string" },
  },
};
const entitiesSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "file", "fields", "relationships", "constraints"],
    properties: {
      name: { type: "string" },
      file: { type: ["string", "null"] },
      fields: { type: "array", items: fieldSchema },
      relationships: { type: "array", items: relationshipSchema },
      constraints: { type: "array", items: constraintSchema },
    },
  },
};

export const headSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["storage", "entities"],
  properties: {
    storage: {
      type: "string",
      description:
        'The kinds of store this program keeps its records in, in at most 15 plain words, with no file names, keys or contents, e.g. "A Postgres database." or "JSON files in the app\'s folders, UserDefaults and the Keychain."',
    },
    entities: entitiesSchema,
  },
});

const deltaSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["changed", "absent"],
  properties: {
    changed: entitiesSchema,
    absent: { type: "array", items: { type: "string" } },
    storage: {
      type: "string",
      description:
        "Only when the patch adds or removes a kind of store: this commit's storage sentence, in the same form as the model below",
    },
  },
});

const RULES = `- An entity is a kind of record that is stored and read back. Leave out types that only travel (API request and response shapes, props, view models, in-memory caches that are rebuilt) unless they are themselves written to storage.
- Fields are the stored properties, with the language's own type name ("string", "number", "string[]", a union written out, including "| null" when it can be null). required is false only when the key itself may be missing from a stored record (an optional property, or an older record written before the field existed); a field that is always present but may be null is required, with "| null" in its type.
- A field whose values are a fixed set of literals is an enum: put them in values.
- A relationship is a stored reference from one entity to another (an id, a list of ids, an embedded record of another entity). "belongs to" for a reference by id this entity holds, "has many" or "has one" for the other end. "contains" for a value of another entity's type embedded whole in this record's stored form (a nested struct, an embedded document), named after the field that holds it. target is the entity's name. fields lists this entity's fields that hold it.
- A constraint is a rule the code enforces on stored data: "unique" for a key that identifies a record, "foreign key" for a reference that must resolve.
- file is the path of the file that declares the entity's type.
- Name each entity after the record it stores, in PascalCase: the table, collection or record type, never the variable or constant that declares it. A table declared as \`incidentTable\` for the table "incident" is Incident, not IncidentTable.`;

const steering = (files: string[] | null) =>
  files
    ? `\nThe data model is declared in the files matching these globs: ${files.join(" ")}. Read those; leave out records declared anywhere else.\n`
    : "";

export const headPrompt = (files: string[] | null = null) =>
  `You are reading the code of one commit of a repository, in the current directory. Nothing may be run.

Write down this program's data model: the records it persists, the things a reader would draw as an entity-relationship diagram. Whatever the storage is: a database, an ORM, JSON files, a key-value store, browser storage. In storage, name the kinds of store it keeps them in, in at most 15 plain words, with no file names, keys or contents, e.g. "A Postgres database." or "JSON files in the app's folders, UserDefaults and the Keychain."
${steering(files)}
${RULES}

Be precise and complete for the records that are stored; leave out everything else.`;

// Steer the delta as the model it starts from was steered: unsteered, it can
// report a record from outside the files, an entity the start never had.
const deltaPrompt = (
  from: DraftedHead,
  patch: string,
  files: string[] | null = null,
) =>
  `You are reading the code of one commit of a repository, in the current directory. Nothing may be run.

Below is the data model of another commit of this repository, and the patch from that commit to this one. Work out THIS commit's data model by applying what the patch changes in stored records to the model below. Return only the difference:

- changed: for every entity the patch changed or added, its full version as it is in THIS commit. Write each one in the same style as the model below, keeping everything the patch does not touch word for word.
- absent: the names of entities in the model below that the patch removed, so they don't exist here.
- storage: only when the patch adds or removes a kind of store, this commit's storage sentence in the same form. Otherwise leave it out.

An entity the patch does not touch goes in neither list. If the patch changes no stored records, both lists are empty. Check the code here when the patch is unclear.
${steering(files)}
${RULES}

Data model before the patch:
${JSON.stringify({ storage: from.storage, entities: from.entities }, null, 2)}

The patch:
${patch}`;

/** This commit's entities: the start's, with the delta's changed ones in place and its absent ones gone. */
export function mergeDelta(from: Entity[], delta: DraftedDelta): Entity[] {
  const changed = new Map(delta.changed.map((e) => [e.name, e]));
  const absent = new Set(delta.absent);
  const known = new Set(from.map((e) => e.name));
  return [
    ...from
      .filter((e) => !absent.has(e.name))
      .map((e) => changed.get(e.name) ?? e),
    ...delta.changed.filter((e) => !known.has(e.name)),
  ];
}

/** The patch from one tree to another, or null past the cap, so the caller reads in full instead. */
export async function forwardPatch(
  root: string,
  from: string,
  to: string,
): Promise<string | null> {
  const { stdout } = await git(
    root,
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, to],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  return Buffer.byteLength(stdout) > MAX_PATCH_BYTES ? null : stdout;
}

export function readHead(
  root: string,
  head: string,
  runner: Runner,
  files: string[] | null,
): Promise<AiResult<DraftedHead>> {
  return withSnapshot(root, head, (dir) =>
    runner<DraftedHead>(headPrompt(files), headSchema(), dir),
  );
}

/** Reads the commit `at` as the delta from `from`'s model, given the patch between them. */
export function readDelta(
  root: string,
  at: string,
  from: DraftedHead,
  patch: string,
  runner: Runner,
  files: string[] | null,
): Promise<AiResult<DraftedDelta>> {
  return withSnapshot(root, at, (dir) =>
    runner<DraftedDelta>(deltaPrompt(from, patch, files), deltaSchema(), dir),
  );
}
