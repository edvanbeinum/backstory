import { promises as fs } from "node:fs";
import path from "node:path";

import picomatch from "picomatch";

import { DslError, readDsl } from "./dsl";
import { gitTry } from "./exec";
import { gitCommonDir, repoKey, repoKeyOf } from "./git";
import { homeDir } from "./store";

/**
 * The repo's C4 model: `architecture/workspace.dsl`, in Structurizr's DSL.
 * Backstory only reads it. Elements are keyed by their DSL identifier
 * (`ios.progress`), which survives elements being added.
 */

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
  /** The workspace's own properties, such as `backstory.drafted` */
  properties: Record<string, string>;
}

/** A model as the DSL reader finds it, before Backstory builds its matchers. */
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

export const splitGlobs = (value: string | undefined) =>
  value?.split(/\s+/).filter(Boolean) ?? [];

/**
 * Same options as the Step 0 script: `dot: true`, so a file such as a Core
 * Data app's `Model.xcdatamodeld/.xccurrentversion` maps like any other. Node's
 * `path.matchesGlob` skips dotfiles.
 */
const matcher = (globs: string[]) =>
  globs.length > 0 ? picomatch(globs, { dot: true }) : () => false;

const orDefault = (
  globs: string[],
  fallback: () => (path: string) => boolean,
) => (globs.length > 0 ? matcher(globs) : (path: string) => fallback()(path));

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

  // Several arrows between one pair read as one, labelled with all of them.
  const grouped = new Map<
    string,
    { rel: ModelRelationship; labels: string[] }
  >();
  for (const { source, destination, description } of ws.relationships) {
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
    properties: ws.properties,
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
 * `~/.backstory/models/<repo key>/workspace.dsl`, so every worktree of a repo
 * finds it and two repos whose checkouts share a folder name don't. One model
 * for every commit, so it can say where a change landed but not what it
 * added or removed.
 */
export async function localModelDir(root: string): Promise<string> {
  return path.join(homeDir(), "models", await repoKey(root));
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

function unlessMissing(err: NodeJS.ErrnoException) {
  if (err.code !== "ENOENT") throw err;
}

/**
 * The local model's file. Moves a model still in the folder named after the
 * main checkout alone, `~/.backstory/models/<folder>/`, the first time it's
 * looked for, rather than reading it there: read in place, two repos with
 * that folder name would go on sharing it, and a Draft wouldn't see it.
 * Ignores a file that's gone mid-move, so two reads moving it at once don't
 * throw.
 */
export async function localModelFile(root: string): Promise<string> {
  const common = await gitCommonDir(root);
  const dir = path.join(homeDir(), "models", repoKeyOf(common ?? root));
  const file = path.join(dir, "workspace.dsl");
  if (await exists(file)) return file;
  const old = path.join(
    homeDir(),
    "models",
    path.basename(path.dirname(common ?? path.join(root, ".git"))),
  );
  if (!(await exists(path.join(old, "workspace.dsl")))) return file;
  await fs.mkdir(dir, { recursive: true });
  for (const name of ["workspace.dsl", "workspace.dsl.bak"]) {
    await fs
      .rename(path.join(old, name), path.join(dir, name))
      .catch(unlessMissing);
  }
  await fs.rmdir(old).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOTEMPTY" && err.code !== "EEXIST") unlessMissing(err);
  });
  return file;
}

/**
 * The workspace property a drafted model carries, with the day it was
 * drafted. A property, not the header comment, because the reader skips
 * comments; removing it after correcting a draft drops the Draft chip.
 */
export const DRAFTED_PROPERTY = "backstory.drafted";

export interface ModelRead {
  /** Null when the file is there but couldn't be read: see `error` */
  model: Model | null;
  local: boolean;
  /** The local model's path; null for a committed one */
  file: string | null;
  drafted: string | null;
  error: string | null;
}

function read(text: string, file: string | null): ModelRead {
  const local = file !== null;
  try {
    const model = parseDsl(text);
    return {
      model,
      local,
      file,
      drafted: model.properties[DRAFTED_PROPERTY] ?? null,
      error: null,
    };
  } catch (e) {
    return {
      model: null,
      local,
      file,
      drafted: null,
      error: e instanceof DslError ? e.message : String(e),
    };
  }
}

/**
 * The model at the rev, or else the one kept on this machine. A DSL that
 * fails to read gives its error and no model, so flows filter files as in a
 * repo with no model: a change the model would mark as tests or ignored can
 * still cost a `claude -p` trace. That's the cost any repo without a model
 * already pays, and the map strip shows the error so it gets fixed.
 */
export async function readModelAt(
  root: string,
  rev: string,
): Promise<ModelRead | null> {
  const dsl = await showFile(root, rev, MODEL_DSL);
  if (dsl !== null) return read(dsl, null);
  const file = await localModelFile(root);
  const local = await fs.readFile(file, "utf8").catch(() => null);
  return local === null ? null : read(local, file);
}

/**
 * Tests and ignored files stay off the flows and the map. Without a model,
 * a default test pattern stands in, so a repo with no `architecture/` still
 * gets flows over its app code.
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
