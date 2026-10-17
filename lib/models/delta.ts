import type { AiResult, Runner } from "../ai/provider";
import { withSnapshot } from "../flows/generate";
import {
  splitGlobs,
  type ElementType,
  type Workspace,
  type WorkspaceElement,
  type WorkspaceRelationship,
} from "../model";
import { globList, isWithin } from "./dsl";

/**
 * A drafted map read forward: the provider gets the map of an earlier commit
 * and the patch from it to this one, and returns only what the patch changed
 * in the system's structure. Asked for a whole map again, it would rename
 * and regroup components by judgement, and the map would show that as
 * change.
 */

export interface MapDeltaElement {
  id: string;
  name: string;
  description: string;
  type: ElementType;
  parent: string | null;
  globs: string[];
}

export interface MapDelta {
  /** This commit's version of each element the patch changed or added */
  changed: MapDeltaElement[];
  /** Ids of elements the patch removed */
  absent: string[];
  /** Every arrow this commit has between each pair whose arrows the patch changed */
  arrows: WorkspaceRelationship[];
  /** Pairs whose arrows the patch removed */
  absentArrows: { source: string; destination: string }[];
}

const strings = { type: "array", items: { type: "string" } };

export const mapDeltaSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["changed", "absent", "arrows", "absentArrows"],
  properties: {
    changed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "description", "type", "parent", "globs"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          type: {
            enum: ["person", "softwareSystem", "container", "component"],
          },
          parent: { type: ["string", "null"] },
          globs: strings,
        },
      },
    },
    absent: strings,
    arrows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "destination", "description"],
        properties: {
          source: { type: "string" },
          destination: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    absentArrows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "destination"],
        properties: {
          source: { type: "string" },
          destination: { type: "string" },
        },
      },
    },
  },
});

/** The start map as the prompt shows it: ids, names, globs and arrows, without DSL. */
function startJson(from: Workspace) {
  return {
    elements: from.elements.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      type: e.type,
      parent: e.parent,
      globs: splitGlobs(e.properties["code.globs"]),
    })),
    relationships: from.relationships,
    tests: splitGlobs(from.properties["code.tests"]),
    ignore: splitGlobs(from.properties["code.ignore"]),
  };
}

export const mapDeltaPrompt = (from: Workspace, patch: string) =>
  `You are reading the code of one commit of a repository, in the current directory. Read files with Read, Grep and Glob. Don't modify anything.

Below is a C4 model of another commit of this repository, and the patch from that commit to this one. Work out THIS commit's model by applying what the patch changes in the system's structure to the model below. Return only the difference:

- changed: for every element the patch changed or added, its full version as it is in THIS commit: id, name, description, type, parent and globs. A new component, container, person or external system goes here, and so does an element whose globs must change so that every app file the patch adds belongs to exactly one component.
- absent: the ids of elements in the model below that the patch removed.
- arrows: for each pair of elements whose arrows the patch changed or added, every arrow THIS commit has between them, with source, destination and a short description ("Reads and writes", "Sends events to").
- absentArrows: the pairs, source and destination, whose arrows the patch removed altogether.

An element or arrow the patch does not touch goes in no list. If the patch changes nothing in the system's structure, every list is empty. Check the code here when the patch is unclear.

Keep every id exactly as the model below has it. A new element's id is its parent's id, a dot, and a short lower-camel-case word unique among its siblings, in the same style ("shop.web.syncEngine"); a person or external system has no parent and a one-word id. Write names and descriptions in the same style as the model below, keeping everything the patch does not touch word for word. Globs are matched against paths relative to the repository root with picomatch (\`**\` crosses folders; dotfiles match); a glob must not contain spaces.

Model before the patch:
${JSON.stringify(startJson(from), null, 2)}

The patch:
${patch}`;

const pair = (r: { source: string; destination: string }) =>
  `${r.source}\n${r.destination}`;

function toElement(
  e: MapDeltaElement,
  old: WorkspaceElement | undefined,
): WorkspaceElement {
  const { "code.globs": _globs, ...properties } = old?.properties ?? {};
  const globs = globList(e.globs);
  return {
    id: e.id,
    name: e.name.trim() || e.id.slice(e.id.lastIndexOf(".") + 1),
    description: e.description,
    type: e.type,
    parent: e.parent || null,
    properties: globs ? { ...properties, "code.globs": globs } : properties,
  };
}

/**
 * This commit's map: the start's, with `changed` replacing or adding
 * elements, `absent` gone with every arrow that touches them, and each named
 * pair's arrows replaced by `arrows` or dropped by `absentArrows`. Then, as
 * the DSL writer does, drops an element whose parent is missing or that sits
 * inside itself, and an arrow with a missing end or that joins an element to
 * itself or its parent.
 */
export function mergeMapDelta(from: Workspace, delta: MapDelta): Workspace {
  const absent = new Set(delta.absent);
  const before = new Map(from.elements.map((e) => [e.id, e]));
  const changed = new Map(
    delta.changed.map((e) => [e.id, toElement(e, before.get(e.id))]),
  );
  const merged = [
    ...from.elements
      .filter((e) => !absent.has(e.id))
      .map((e) => changed.get(e.id) ?? e),
    ...[...changed.values()].filter((e) => !before.has(e.id)),
  ];
  // Keep only elements whose parents lead to a top-level one: a parent cycle
  // from the provider would otherwise survive and hang `buildMap`'s walk up.
  const byId = new Map(merged.map((e) => [e.id, e]));
  const elements = merged.filter((e) => {
    const seen = new Set([e.id]);
    for (let p = e.parent; p !== null;) {
      const parent = byId.get(p);
      if (!parent || seen.has(p)) return false;
      seen.add(p);
      p = parent.parent;
    }
    return true;
  });

  const replaced = new Set([...delta.arrows, ...delta.absentArrows].map(pair));
  const ids = new Set(elements.map((e) => e.id));
  const seen = new Set<string>();
  const relationships = [
    ...from.relationships.filter((r) => !replaced.has(pair(r))),
    ...delta.arrows,
  ].filter((r) => {
    const key = `${pair(r)}\n${r.description}`;
    if (
      seen.has(key) ||
      !ids.has(r.source) ||
      !ids.has(r.destination) ||
      isWithin(r.source, r.destination) ||
      isWithin(r.destination, r.source)
    )
      return false;
    seen.add(key);
    return true;
  });

  return {
    properties: from.properties,
    elements,
    relationships: relationships.map(
      ({ source, destination, description }) => ({
        source,
        destination,
        description,
      }),
    ),
  };
}

/** Reads the commit `at` as the difference from `from`'s map, given the patch between them. */
export function readMapDelta(
  root: string,
  at: string,
  from: Workspace,
  patch: string,
  runner: Runner,
): Promise<AiResult<MapDelta>> {
  return withSnapshot(root, at, (dir) =>
    runner<MapDelta>(mapDeltaPrompt(from, patch), mapDeltaSchema(), dir),
  );
}
