import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import picomatch from "picomatch";

import { readDsl } from "./dsl";
import { gitLine, gitTry } from "./exec";

/**
 * The repo's C4 model: `architecture/workspace.json`, exported by Structurizr
 * from the committed `workspace.dsl`. differ only reads it. Elements are keyed
 * by their DSL identifier (`ios.progress`), which survives elements being
 * added, unlike Structurizr's numeric ids.
 */

export const MODEL_JSON = "architecture/workspace.json";
export const MODEL_DSL = "architecture/workspace.dsl";

export type ElementType =
  "person" | "softwareSystem" | "container" | "component";

export interface ModelElement {
  id: string;
  name: string;
  description: string;
  type: ElementType;
  parent: string | null;
  globs: string[];
}

export interface ModelRelationship {
  /** "source → destination", by identifier */
  key: string;
  source: string;
  destination: string;
  description: string;
}

export interface Model {
  elements: Map<string, ModelElement>;
  /** Explicit arrows only, not the ones Structurizr implies for parents */
  relationships: Map<string, ModelRelationship>;
  /** Leaf element ids whose globs match a path */
  match: (path: string) => string[];
  isTest: (path: string) => boolean;
  isIgnored: (path: string) => boolean;
  /** The DSL embedded in the JSON at export, for the stale check */
  embeddedDsl: string | null;
}

/** A model as either reader finds it, before differ builds its matchers. */
export interface Workspace {
  properties: Record<string, string>;
  elements: WorkspaceElement[];
  relationships: WorkspaceRelationship[];
}

export interface WorkspaceElement {
  id: string;
  name: string;
  description: string;
  type: ElementType;
  parent: string | null;
  properties: Record<string, string>;
}

export interface WorkspaceRelationship {
  source: string;
  destination: string;
  description: string;
}

interface RawElement {
  id: string;
  name?: string;
  description?: string;
  properties?: Record<string, string>;
  relationships?: RawRelationship[];
  containers?: RawElement[];
  components?: RawElement[];
}

interface RawRelationship {
  sourceId: string;
  destinationId: string;
  description?: string;
  linkedRelationshipId?: string;
}

interface RawWorkspace {
  properties?: Record<string, string>;
  model?: { people?: RawElement[]; softwareSystems?: RawElement[] };
}

const splitGlobs = (value: string | undefined) =>
  value?.split(/\s+/).filter(Boolean) ?? [];

/**
 * Same options as the Step 0 script: `dot: true`, so a file such as
 * `LiftMachine.xcdatamodeld/.xccurrentversion` maps like any other. Node's
 * `path.matchesGlob` skips dotfiles.
 */
const matcher = (globs: string[]) =>
  globs.length > 0 ? picomatch(globs, { dot: true }) : () => false;

const orDefault = (
  globs: string[],
  fallback: () => (path: string) => boolean,
) => (globs.length > 0 ? matcher(globs) : (path: string) => fallback()(path));

/** A Structurizr JSON export, with its numeric ids turned into DSL identifiers. */
export function fromJson(raw: RawWorkspace): Workspace {
  const elements: WorkspaceElement[] = [];
  const byNumericId = new Map<string, string>();
  const rawRels: RawRelationship[] = [];

  const visit = (el: RawElement, type: ElementType, parent: string | null) => {
    const id = el.properties?.["structurizr.dsl.identifier"] ?? el.id;
    elements.push({
      id,
      name: el.name ?? id,
      description: el.description ?? "",
      type,
      parent,
      properties: el.properties ?? {},
    });
    byNumericId.set(el.id, id);
    rawRels.push(...(el.relationships ?? []));
    for (const c of el.containers ?? []) visit(c, "container", id);
    for (const c of el.components ?? []) visit(c, "component", id);
  };
  for (const p of raw.model?.people ?? []) visit(p, "person", null);
  for (const s of raw.model?.softwareSystems ?? [])
    visit(s, "softwareSystem", null);

  const relationships: WorkspaceRelationship[] = [];
  for (const r of rawRels) {
    if (r.linkedRelationshipId) continue;
    const source = byNumericId.get(r.sourceId);
    const destination = byNumericId.get(r.destinationId);
    if (!source || !destination) continue;
    relationships.push({
      source,
      destination,
      description: r.description ?? "",
    });
  }
  return { properties: raw.properties ?? {}, elements, relationships };
}

export function buildModel(ws: Workspace): Model {
  const elements = new Map<string, ModelElement>();
  for (const el of ws.elements) {
    elements.set(el.id, {
      id: el.id,
      name: el.name,
      description: el.description,
      type: el.type,
      parent: el.parent,
      globs: splitGlobs(el.properties["code.globs"]),
    });
  }

  // The export lists each arrow under its source element; ordering the DSL's
  // the same way gives both readers the same map, edge for edge.
  const order = new Map(ws.elements.map((e, i) => [e.id, i]));
  const rels = ws.relationships
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        (order.get(a.r.source) ?? 0) - (order.get(b.r.source) ?? 0) ||
        a.i - b.i,
    )
    .map(({ r }) => r);

  // Several arrows between one pair read as one, labelled with all of them.
  const grouped = new Map<
    string,
    { rel: ModelRelationship; labels: string[] }
  >();
  for (const { source, destination, description } of rels) {
    const key = `${source} → ${destination}`;
    const entry = grouped.get(key) ?? {
      rel: { key, source, destination, description: "" },
      labels: [],
    };
    entry.labels.push(description);
    grouped.set(key, entry);
  }
  const relationships = new Map<string, ModelRelationship>();
  for (const [key, { rel, labels }] of grouped) {
    relationships.set(key, { ...rel, description: labels.sort().join("; ") });
  }

  const leaves = [...elements.values()]
    .filter((e) => e.globs.length > 0)
    .map((e) => ({ id: e.id, test: matcher(e.globs) }));

  return {
    elements,
    relationships,
    match: (path) => leaves.filter((l) => l.test(path)).map((l) => l.id),
    // A model that doesn't say which files are tests or ignored keeps the
    // built-in patterns, rather than counting every test as app code.
    isTest: orDefault(
      splitGlobs(ws.properties["code.tests"]),
      () => DEFAULT_TESTS,
    ),
    isIgnored: orDefault(
      splitGlobs(ws.properties["code.ignore"]),
      () => DEFAULT_IGNORE,
    ),
    embeddedDsl: null,
  };
}

export function parseModel(json: string): Model {
  const raw = JSON.parse(json) as RawWorkspace;
  const embedded = raw.properties?.["structurizr.dsl"];
  return {
    ...buildModel(fromJson(raw)),
    embeddedDsl: embedded
      ? Buffer.from(embedded, "base64").toString("utf8")
      : null,
  };
}

export const parseDsl = (text: string): Model => buildModel(readDsl(text));

/** A file's contents at a commit, or null if it isn't there. */
export async function showFile(
  root: string,
  rev: string,
  path: string,
): Promise<string | null> {
  return gitTry(root, ["show", `${rev}:${path}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * A model kept on this machine for a repo that doesn't commit one:
 * `~/.differ/models/<repo>/workspace.json`, named after the main checkout's
 * folder so every worktree finds it. One model for every commit, so it can
 * say where a change landed but not what it added or removed.
 */
export async function localModelDir(root: string): Promise<string> {
  const common =
    (await gitLine(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])) ?? path.join(root, ".git");
  const home = process.env.DIFFER_HOME || path.join(homedir(), ".differ");
  return path.join(home, "models", path.basename(path.dirname(common)));
}

async function readLocalModel(root: string) {
  const dir = await localModelDir(root);
  const json = await fs
    .readFile(path.join(dir, "workspace.json"), "utf8")
    .catch(() => null);
  if (!json) return null;
  const dsl = await fs
    .readFile(path.join(dir, "workspace.dsl"), "utf8")
    .catch(() => null);
  return { json, dsl };
}

export async function readModelAt(
  root: string,
  rev: string,
): Promise<{ model: Model; stale: boolean; local: boolean } | null> {
  let json = await showFile(root, rev, MODEL_JSON);
  let dsl: string | null = null;
  let local = false;
  if (json) {
    dsl = await showFile(root, rev, MODEL_DSL);
  } else {
    const found = await readLocalModel(root);
    if (!found) return null;
    ({ json, dsl } = found);
    local = true;
  }
  let model: Model;
  try {
    model = parseModel(json);
  } catch {
    return null;
  }
  // The JSON carries the DSL it was exported from. If the DSL has moved on,
  // someone edited the model and didn't re-export.
  const stale =
    dsl !== null &&
    model.embeddedDsl !== null &&
    dsl.trim() !== model.embeddedDsl.trim();
  return { model, stale, local };
}

/**
 * Tests and ignored files stay off the flows and the map. Without a model,
 * a default test pattern stands in, so a repo with no `architecture/` (Indee)
 * still gets flows over its app code.
 */
const DEFAULT_TESTS = matcher([
  "**/test/**",
  "**/tests/**",
  "**/spec/**",
  "**/__tests__/**",
  "**/*Tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_spec.*",
  "**/*_test.*",
  "**/*Tests.swift",
]);
const DEFAULT_IGNORE = matcher([
  "**/*.md",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Gemfile.lock",
  "**/*.lock",
  "architecture/**",
  "**/*.snap",
  // Generated by tools, not written: a hash or a snapshot changing is not
  // behaviour changing.
  "archspec_facts/**",
  "archspec_todo.yml",
  "**/*.generated.*",
  "**/__generated__/**",
]);

export function isAppCode(model: Model | null, path: string): boolean {
  // The model describes the code; it never is the code.
  if (path.startsWith("architecture/")) return false;
  if (model) return !model.isTest(path) && !model.isIgnored(path);
  return !DEFAULT_TESTS(path) && !DEFAULT_IGNORE(path);
}
