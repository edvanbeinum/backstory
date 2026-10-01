import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import picomatch from "picomatch";

import { gitLine, gitTry } from "./exec";

/**
 * The repo's C4 model: `architecture/workspace.json`, exported by Structurizr
 * from the committed `workspace.dsl`. differ only reads it. Elements are keyed
 * by their DSL identifier (`ios.progress`), which survives elements being
 * added, unlike Structurizr's numeric ids.
 */

export const MODEL_JSON = "architecture/workspace.json";
export const MODEL_DSL = "architecture/workspace.dsl";

export type ElementType = "person" | "softwareSystem" | "container" | "component";

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

export function parseModel(json: string): Model {
  const raw = JSON.parse(json) as RawWorkspace;
  const elements = new Map<string, ModelElement>();
  const byNumericId = new Map<string, string>();
  const rawRels: RawRelationship[] = [];

  const visit = (el: RawElement, type: ElementType, parent: string | null) => {
    const id = el.properties?.["structurizr.dsl.identifier"] ?? el.id;
    elements.set(id, {
      id,
      name: el.name ?? id,
      description: el.description ?? "",
      type,
      parent,
      globs: splitGlobs(el.properties?.["code.globs"]),
    });
    byNumericId.set(el.id, id);
    rawRels.push(...(el.relationships ?? []));
    for (const c of el.containers ?? []) visit(c, "container", id);
    for (const c of el.components ?? []) visit(c, "component", id);
  };
  for (const p of raw.model?.people ?? []) visit(p, "person", null);
  for (const s of raw.model?.softwareSystems ?? []) visit(s, "softwareSystem", null);

  // Several arrows between one pair read as one, labelled with all of them.
  const grouped = new Map<string, { rel: ModelRelationship; labels: string[] }>();
  for (const r of rawRels) {
    if (r.linkedRelationshipId) continue;
    const source = byNumericId.get(r.sourceId);
    const destination = byNumericId.get(r.destinationId);
    if (!source || !destination) continue;
    const key = `${source} → ${destination}`;
    const entry = grouped.get(key) ?? {
      rel: { key, source, destination, description: "" },
      labels: [],
    };
    entry.labels.push(r.description ?? "");
    grouped.set(key, entry);
  }
  const relationships = new Map<string, ModelRelationship>();
  for (const [key, { rel, labels }] of grouped) {
    relationships.set(key, { ...rel, description: labels.sort().join("; ") });
  }

  const leaves = [...elements.values()]
    .filter((e) => e.globs.length > 0)
    .map((e) => ({ id: e.id, test: matcher(e.globs) }));

  const embedded = raw.properties?.["structurizr.dsl"];
  return {
    elements,
    relationships,
    match: (path) => leaves.filter((l) => l.test(path)).map((l) => l.id),
    isTest: matcher(splitGlobs(raw.properties?.["code.tests"])),
    isIgnored: matcher(splitGlobs(raw.properties?.["code.ignore"])),
    embeddedDsl: embedded ? Buffer.from(embedded, "base64").toString("utf8") : null,
  };
}

/** A file's contents at a commit, or null if it isn't there. */
export async function showFile(
  root: string,
  rev: string,
  path: string,
): Promise<string | null> {
  return gitTry(root, ["show", `${rev}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
}

/**
 * A model kept on this machine for a repo that doesn't commit one:
 * `~/.differ/models/<repo>/workspace.json`, named after the main checkout's
 * folder so every worktree finds it. One model for every commit, so it can
 * say where a change landed but not what it added or removed.
 */
export async function localModelDir(root: string): Promise<string> {
  const common =
    (await gitLine(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) ??
    path.join(root, ".git");
  const home = process.env.DIFFER_HOME || path.join(homedir(), ".differ");
  return path.join(home, "models", path.basename(path.dirname(common)));
}

async function readLocalModel(root: string) {
  const dir = await localModelDir(root);
  const json = await fs.readFile(path.join(dir, "workspace.json"), "utf8").catch(() => null);
  if (!json) return null;
  const dsl = await fs.readFile(path.join(dir, "workspace.dsl"), "utf8").catch(() => null);
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
]);

export function isAppCode(model: Model | null, path: string): boolean {
  // The model describes the code; it never is the code.
  if (path.startsWith("architecture/")) return false;
  if (model) return !model.isTest(path) && !model.isIgnored(path);
  return !DEFAULT_TESTS(path) && !DEFAULT_IGNORE(path);
}
