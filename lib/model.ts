import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import picomatch from "picomatch";

import { DslError, readDsl } from "./dsl";
import { gitLine, gitTry } from "./exec";

/**
 * The repo's C4 model: `architecture/workspace.dsl`, in Structurizr's DSL.
 * differ only reads it. Elements are keyed by their DSL identifier
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
}

/** A model as the DSL reader finds it, before differ builds its matchers. */
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
 * `~/.differ/models/<repo>/workspace.dsl`, named after the main checkout's
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

export interface ModelRead {
  /** Null when the file is there but couldn't be read: see `error` */
  model: Model | null;
  local: boolean;
  error: string | null;
}

function read(text: string, local: boolean): ModelRead {
  try {
    return { model: parseDsl(text), local, error: null };
  } catch (e) {
    return {
      model: null,
      local,
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
  if (dsl !== null) return read(dsl, false);
  const local = await fs
    .readFile(path.join(await localModelDir(root), "workspace.dsl"), "utf8")
    .catch(() => null);
  return local === null ? null : read(local, true);
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
