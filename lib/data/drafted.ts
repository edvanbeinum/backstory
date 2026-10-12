import type { AiResult, Runner } from "../ai/provider";
import { git } from "../exec";
import { withSnapshot } from "../flows/generate";
import type { Entity } from "./types";

/**
 * The AI provider's reading of a data model, for a repo no data reader
 * understands. The head is read in full. The base is read as a delta from
 * the head: the provider gets the head's model and the patch and returns only
 * the entities the patch changed. Two independent reads disagree on
 * judgement calls, and the diff would report the disagreement as change; and
 * asked for a whole base model, the provider drops the untouched entities of
 * a large one.
 */

/** Patches past this aren't sent: "All changes" on a long branch is the case it guards. */
export const MAX_PATCH_BYTES = 400 * 1024;
export const TOO_LARGE = "This change is too large to draft a data model from";

export interface DraftedHead {
  /** One sentence: where and how the program keeps its data */
  storage: string;
  entities: Entity[];
}

export interface DraftedDelta {
  /** The base's version of each entity the patch changed, or that the patch removed */
  changed: Entity[];
  /** Head entities the patch added, so the base doesn't have them */
  absent: string[];
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
    kind: { enum: ["belongs to", "has many", "has one", "many to many"] },
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
        "One short sentence: where and how this program keeps its data",
    },
    entities: entitiesSchema,
  },
});

export const deltaSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["changed", "absent"],
  properties: {
    changed: entitiesSchema,
    absent: { type: "array", items: { type: "string" } },
  },
});

const RULES = `- An entity is a kind of record that is stored and read back. Leave out types that only travel (API request and response shapes, props, view models, in-memory caches that are rebuilt) unless they are themselves written to storage.
- Fields are the stored properties, with the language's own type name ("string", "number", "string[]", a union written out, including "| null" when it can be null). required is false only when the key itself may be missing from a stored record (an optional property, or an older record written before the field existed); a field that is always present but may be null is required, with "| null" in its type.
- A field whose values are a fixed set of literals is an enum: put them in values.
- A relationship is a stored reference from one entity to another (an id, a list of ids, an embedded record of another entity). "belongs to" for a reference this entity holds, "has many" or "has one" for the other end. target is the entity's name. fields lists this entity's fields that hold it.
- A constraint is a rule the code enforces on stored data: "unique" for a key that identifies a record, "foreign key" for a reference that must resolve.
- file is the path of the file that declares the entity's type.
- Name each entity after the record it stores, in PascalCase: the table, collection or record type, never the variable or constant that declares it. A table declared as \`incidentTable\` for the table "incident" is Incident, not IncidentTable.`;

export const headPrompt = () =>
  `You are reading the code of one commit of a repository, in the current directory. Nothing may be run.

Write down this program's data model: the records it persists, the things a reader would draw as an entity-relationship diagram. Whatever the storage is: a database, an ORM, JSON files, a key-value store, browser storage. In storage, say in one short sentence where and how it keeps them.

${RULES}

Be precise and complete for the records that are stored; leave out everything else.`;

export const deltaPrompt = (head: DraftedHead, patch: string) =>
  `You are reading the code of one commit of a repository, in the current directory. Nothing may be run.

Below is the data model of the commit that comes after this one, and the patch between the two. Work out how THIS commit's data model differs from it, by undoing what the patch changed in stored records. Return only the difference:

- changed: for every entity the patch changed, its full version as it is in THIS commit. Include an entity that exists here but the patch removed. Write each one in the same style as the model below, keeping everything the patch does not touch word for word.
- absent: the names of entities in the model below that the patch added, so they don't exist here.

An entity the patch does not touch goes in neither list. If the patch changes no stored records, both lists are empty. Check the code here when the patch is unclear.

${RULES}

Data model after the patch:
${JSON.stringify({ storage: head.storage, entities: head.entities }, null, 2)}

The patch:
${patch}`;

/** The base's entities: the head's, with the delta's changed ones in place and its absent ones gone. */
export function mergeDelta(head: Entity[], delta: DraftedDelta): Entity[] {
  const changed = new Map(delta.changed.map((e) => [e.name, e]));
  const absent = new Set(delta.absent);
  const known = new Set(head.map((e) => e.name));
  return [
    ...head
      .filter((e) => !absent.has(e.name))
      .map((e) => changed.get(e.name) ?? e),
    ...delta.changed.filter((e) => !known.has(e.name)),
  ];
}

/** The base..head patch to undo, or a failure when it's past the cap. */
export async function deltaPatch(
  root: string,
  base: string,
  head: string,
): Promise<string> {
  const { stdout } = await git(
    root,
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, head],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (Buffer.byteLength(stdout) > MAX_PATCH_BYTES) throw new Error(TOO_LARGE);
  return stdout;
}

export function readHead(
  root: string,
  head: string,
  runner: Runner,
): Promise<AiResult<DraftedHead>> {
  return withSnapshot(root, head, (dir) =>
    runner<DraftedHead>(headPrompt(), headSchema(), dir),
  );
}

export function readDelta(
  root: string,
  base: string,
  head: DraftedHead,
  patch: string,
  runner: Runner,
): Promise<AiResult<DraftedDelta>> {
  return withSnapshot(root, base, (dir) =>
    runner<DraftedDelta>(deltaPrompt(head, patch), deltaSchema(), dir),
  );
}
