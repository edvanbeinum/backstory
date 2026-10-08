/**
 * What Claude is asked when it drafts a C4 model, and the shape it answers
 * in. Claude returns structured output, never DSL text: Backstory writes the
 * DSL itself (`dsl.ts`), so a draft can't fail to parse.
 */

export interface DraftElement {
  id: string;
  name: string;
  description: string;
}

export interface DraftComponent extends DraftElement {
  technology: string;
  globs: string[];
}

export interface DraftContainer extends DraftElement {
  technology: string;
  components: DraftComponent[];
}

export interface DraftRelationship {
  source: string;
  destination: string;
  description: string;
}

export interface DraftOutput {
  name: string;
  description: string;
  people: DraftElement[];
  externalSystems: DraftElement[];
  system: DraftElement & { containers: DraftContainer[] };
  relationships: DraftRelationship[];
  tests: string[];
  ignore: string[];
}

export interface GlobFixOutput {
  components: { id: string; globs: string[] }[];
}

const strings = { type: "array", items: { type: "string" } };

const element = (extra: Record<string, object> = {}) => ({
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    ...extra,
  },
  required: ["id", "name", "description", ...Object.keys(extra)],
});

export const draftSchema = () => ({
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    people: { type: "array", items: element() },
    externalSystems: { type: "array", items: element() },
    system: element({
      containers: {
        type: "array",
        items: element({
          technology: { type: "string" },
          components: {
            type: "array",
            items: element({ technology: { type: "string" }, globs: strings }),
          },
        }),
      },
    }),
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          destination: { type: "string" },
          description: { type: "string" },
        },
        required: ["source", "destination", "description"],
      },
    },
    tests: strings,
    ignore: strings,
  },
  required: [
    "name",
    "description",
    "people",
    "externalSystems",
    "system",
    "relationships",
    "tests",
    "ignore",
  ],
});

export const globFixSchema = () => ({
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, globs: strings },
        required: ["id", "globs"],
      },
    },
  },
  required: ["components"],
});

export function draftPrompt(opts: { sha: string; files: number }): string {
  return `You are drafting a C4 model of a codebase, for a reviewer who wants to see which parts of the system a change lands in. A person will correct your draft afterwards, so a clear, plausible structure matters more than completeness of descriptions.

The repository at commit ${opts.sha} is in the current directory: ${opts.files} tracked files. Read files with Read, Grep and Glob. Don't modify anything.

Start with README, AGENTS.md and CLAUDE.md (at the root and in the main folders), if they exist: use the system's own names for its parts.

Return:
- name and description: the workspace, named after the system.
- people: the kinds of user who use the system.
- externalSystems: systems outside this repository that it talks to (APIs, services, stores it doesn't own).
- system: the one software system this repository is, with its containers. A container is a separately running or deployed thing: an app, a server, a worker, a database, a CLI.
- components inside each container: the units a reader of the code would name when saying where a change went ("the sync engine", "billing", "the settings screen"). Roughly 6 to 15 per container. Each has a technology (language or framework, a few words) and globs.
- relationships: who uses or calls whom, between any of the elements above, by id, with a short description ("Reads and writes", "Sends events to").
- tests: globs for test code, fixtures and test helpers.
- ignore: globs for files that are not app code: docs, lockfiles, generated code, vendored code, assets that aren't behaviour, CI and editor config.

Ids are short lower-camel-case words, unique across the whole model (e.g. "syncEngine"); relationships name elements by these ids.

Globs say which files belong to a component. They are matched against paths relative to the repository root, with picomatch (\`**\` crosses folders; dotfiles match).
- Every app file (each tracked file that tests and ignore don't cover) belongs to exactly one component. Check it with Glob before you answer: no file left out, no file in two components.
- Prefer directory globs ("app/sync/**") to lists of files. List single files only where a folder holds more than one component's code.
- A glob must not contain spaces.`;
}

export function globFixPrompt(opts: {
  sha: string;
  unmatched: string[];
  unmatchedCount: number;
  ambiguous: { file: string; ids: string[] }[];
  ambiguousCount: number;
  components: { id: string; name: string; globs: string[] }[];
}): string {
  const shown = (n: number, list: unknown[]) =>
    n > list.length ? ` (the first ${list.length} of ${n})` : "";
  const sections = [];
  if (opts.unmatched.length > 0)
    sections.push(
      `These app files match no component${shown(opts.unmatchedCount, opts.unmatched)}:\n${opts.unmatched.join("\n")}`,
    );
  if (opts.ambiguous.length > 0)
    sections.push(
      `These app files match more than one component${shown(opts.ambiguousCount, opts.ambiguous)}:\n${opts.ambiguous.map((a) => `${a.file} ← ${a.ids.join(", ")}`).join("\n")}`,
    );
  return `You drafted a C4 model of the repository at commit ${opts.sha}, which is in the current directory. Read files with Read, Grep and Glob. Don't modify anything.

Every app file should belong to exactly one component, by the components' globs (picomatch, paths relative to the repository root, \`**\` crosses folders, dotfiles match). Some don't.

${sections.join("\n\n")}

The components and their globs now:
${opts.components.map((c) => `${c.id} (${c.name}): ${c.globs.join(" ") || "(none)"}`).join("\n")}

Return revised globs for the components that need them, by the ids above, so that each of these files matches exactly one component. Put a file where its code belongs; widen a directory glob rather than listing files where you can. Leave out components whose globs don't change. A glob must not contain spaces.`;
}
