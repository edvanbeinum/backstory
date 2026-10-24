import { promises as fs } from "node:fs";
import path from "node:path";

import { autoRead } from "./data/cache";
import type { TrunkReadStatus } from "./data/types";
import { git } from "./exec";
import { getWorkingTree, MAX_UNTRACKED, MAX_UNTRACKED_BYTES } from "./git";
import {
  isAppCode,
  localModelFile,
  readModelAt,
  type Model,
  type ModelElement,
  type ModelRead,
  type ModelSource,
} from "./model";
import {
  hasMainMap,
  mapStatus,
  mapTrunkStatus,
  type MapDraftStatus,
  type MapView,
} from "./models/cache";
import type { RepoInfo } from "./types";
import { viewRange } from "./view";

/**
 * The system map for a view: which C4 elements the change touched, which
 * the model gained or lost, and how the arrows between them changed. Compared
 * by DSL identifier, with Archify's rules (https://github.com/tt-a1i/archify,
 * MIT): an element is added or removed by its identifier; an arrow by its two
 * ends, so a new label on the same pair reads as changed.
 *
 * Focused on the change: the changed elements and their direct neighbours,
 * each drawn inside the boxes of its container and system. A drafted map is
 * compared like a committed one, base with head.
 */

type NodeState = "touched" | "added" | "removed" | "neighbour";
type EdgeState = "added" | "removed" | "changed" | "same";

export interface MapNode {
  id: string;
  name: string;
  description: string;
  type: string;
  state: NodeState;
  /** The box it's drawn inside: its container or system, when that's drawn */
  parent: string | null;
  /** A container or system drawn as a box around others; never has files */
  group: boolean;
  files: string[];
  /** Each file's own change, in `files` order */
  fileStats: {
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }[];
  additions: number;
  deletions: number;
  newFiles: number;
}

export interface MapEdge {
  key: string;
  source: string;
  destination: string;
  state: EdgeState;
  description: string;
  before?: string;
}

export interface MapResponse {
  status: "ok" | "none";
  /** False when the base has no model: nothing reads as added or removed */
  baseModel: boolean;
  /** Why the head's model file couldn't be read, when it couldn't */
  error: string | null;
  /** Why the base's model file couldn't be read: nothing was compared */
  baseError: string | null;
  /** Where the head's model comes from; missing when there's none */
  source?: ModelSource;
  /** The model is hand-written on this machine, not in the repo: no structural diff */
  local: boolean;
  /** The hand-written local model's path, to correct it; null otherwise */
  modelFile: string | null;
  /** The view's map read, when the repo has no model of its own */
  draft?: MapDraftStatus;
  /** When the repo has no model of its own: whether maps are read as repos and views open */
  auto?: boolean;
  /** When the repo has no model of its own: where a hand-written local model goes */
  handFile?: string;
  /** When the repo has no model of its own: whether main's map is saved */
  mainMap?: boolean;
  /** When the repo has no model of its own: main's read, for whether the repo is big */
  mainRead?: TrunkReadStatus | null;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Every element and arrow, unchanged, when the change touches no component */
  whole?: { nodes: MapNode[]; edges: MapEdge[] };
  /** Components in the model that the focused map leaves out */
  hidden: number;
  /** Each changed file's component, by name, for the diff's file headers */
  fileComponents: Record<string, string>;
  unmapped: string[];
  ambiguous: { file: string; ids: string[] }[];
  /** Every element's description, by name, for the flow's component boxes */
  descriptions: Record<string, string>;
}

interface FileStat {
  path: string;
  oldPath: string;
  additions: number;
  deletions: number;
  status: string;
}

/** Each file's change between the two ends `git diff` is given. */
async function fileStats(root: string, range: string[]): Promise<FileStat[]> {
  const [{ stdout: numstat }, { stdout: names }] = await Promise.all([
    git(root, ["diff", "--numstat", "-M", "-z", ...range]),
    git(root, ["diff", "--name-status", "-M", "-z", ...range]),
  ]);
  const statusOf = new Map<string, string>();
  const nameParts = names.split("\0");
  for (let i = 0; i < nameParts.length - 1;) {
    const status = nameParts[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      i++;
      statusOf.set(nameParts[i++], status[0]);
    } else {
      statusOf.set(nameParts[i++], status[0]);
    }
  }
  // -z numstat: "add\tdel\tpath\0", or for a rename "add\tdel\t\0old\0new\0".
  const out: FileStat[] = [];
  const parts = numstat.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const [a, d, p] = head.split("\t");
    let path = p;
    let oldPath = p;
    if (p === "") {
      oldPath = parts[++i];
      path = parts[++i];
    }
    out.push({
      path,
      oldPath,
      additions: Number(a) || 0,
      deletions: Number(d) || 0,
      status: statusOf.get(path) ?? "M",
    });
  }
  return out;
}

/**
 * Uncommitted work's files: tracked changes against HEAD, staged or not, and
 * the untracked files the working patch shows, up to its cap. A file too big
 * for the patch counts no additions, as the patch shows it as a binary add.
 */
async function workingFileStats(repo: RepoInfo): Promise<FileStat[]> {
  const [tracked, { untrackedPaths }] = await Promise.all([
    fileStats(repo.root, ["HEAD"]),
    getWorkingTree(repo),
  ]);
  for (const rel of untrackedPaths.slice(0, MAX_UNTRACKED)) {
    const stat = await fs.stat(path.join(repo.root, rel)).catch(() => null);
    if (!stat?.isFile()) continue;
    let additions = 0;
    if (stat.size <= MAX_UNTRACKED_BYTES) {
      // --no-index exits 1 whenever it finds differences, which is always here.
      const { stdout } = await git(
        repo.root,
        ["diff", "--numstat", "--no-index", "--", "/dev/null", rel],
        { allowExitCodes: [1] },
      );
      additions = Number(stdout.split("\t")[0]) || 0;
    }
    tracked.push({
      path: rel,
      oldPath: rel,
      additions,
      deletions: 0,
      status: "A",
    });
  }
  return tracked;
}

const leafOf = (model: Model, file: string) => model.match(file);

/** An element's containers and systems, nearest first. */
function ancestors(
  elementOf: (id: string) => ModelElement | undefined,
  id: string,
) {
  const found: string[] = [];
  for (let p = elementOf(id)?.parent; p; p = elementOf(p)?.parent ?? null)
    found.push(p);
  return found;
}

/** Whether `outer` is `inner`'s container or system, at any depth. */
const contains = (
  elementOf: (id: string) => ModelElement | undefined,
  outer: string,
  inner: string,
) => ancestors(elementOf, inner).includes(outer);

const unchanged = (): Pick<
  MapNode,
  "files" | "fileStats" | "additions" | "deletions" | "newFiles"
> => ({
  files: [],
  fileStats: [],
  additions: 0,
  deletions: 0,
  newFiles: 0,
});

/**
 * The whole system, for Show map: every element unchanged, each inside its
 * parent's box, and every arrow as the model names it. An arrow between an
 * element and its own container or system is left out: one box contains
 * the other.
 */
function wholeMap(model: Model): { nodes: MapNode[]; edges: MapEdge[] } {
  const parents = new Set(
    [...model.elements.values()].map((e) => e.parent).filter(Boolean),
  );
  const elementOf = (id: string) => model.elements.get(id);
  const nodes: MapNode[] = [...model.elements.values()].map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    type: e.type,
    state: "neighbour",
    parent: e.parent && model.elements.has(e.parent) ? e.parent : null,
    group: parents.has(e.id),
    ...unchanged(),
  }));
  const edges: MapEdge[] = [...model.relationships.values()]
    .filter(
      (r) =>
        !contains(elementOf, r.source, r.destination) &&
        !contains(elementOf, r.destination, r.source),
    )
    .map((r) => ({
      key: r.key,
      source: r.source,
      destination: r.destination,
      description: r.description,
      state: "same",
    }));
  return { nodes, edges };
}

/** The focused map stays a glance: changed elements plus a few neighbours. */
const MAX_NODES = 7;

const empty = (): MapResponse => ({
  status: "none",
  baseModel: false,
  error: null,
  baseError: null,
  local: false,
  modelFile: null,
  nodes: [],
  edges: [],
  hidden: 0,
  fileComponents: {},
  unmapped: [],
  ambiguous: [],
  descriptions: {},
});

type Reading = Pick<
  MapResponse,
  "draft" | "auto" | "handFile" | "mainMap" | "mainRead"
>;

/**
 * With no model of its own, the repo's map is drafted: how the read of
 * `view` stands, the read whose result the map is drawn on.
 */
async function readingOf(
  headRead: ModelRead | null,
  view: MapView,
): Promise<Reading> {
  if (headRead && headRead.source !== "drafted") return {};
  return {
    draft: await mapStatus(view),
    auto: await autoRead(view.root),
    handFile: await localModelFile(view.root),
    mainMap: await hasMainMap(view.root),
    mainRead: await mapTrunkStatus(view.root),
  };
}

/** The map when the head has no model to draw on. */
function noModel(headRead: ModelRead | null, reading: Reading): MapResponse {
  if (!headRead) return { ...empty(), ...reading };
  return {
    ...empty(),
    source: headRead.source,
    error: headRead.error,
    local: headRead.source === "local",
    modelFile: headRead.file,
  };
}

export async function buildMap(
  root: string,
  base: string | null,
  head: string,
): Promise<MapResponse> {
  const headRead = await readModelAt(root, head);
  const reading = await readingOf(headRead, { root, base, head });
  if (!headRead?.model) return noModel(headRead, reading);
  // A local model is the same for every commit; comparing it with itself
  // would claim "no structural change" when nothing was checked.
  const baseRead =
    base && headRead.source !== "local" ? await readModelAt(root, base) : null;
  const range = base
    ? [base, head]
    : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", head];
  return drawMap(
    headRead.model,
    headRead,
    baseRead,
    await fileStats(root, range),
    reading,
  );
}

/**
 * The map for uncommitted work: the working tree's changes drawn on HEAD's
 * model, which is the model at both ends, so nothing reads as added or
 * removed. A drafted map's status is HEAD's own view's, since that read
 * saves the map HEAD's tree is drawn on.
 */
export async function buildWorkingMap(repo: RepoInfo): Promise<MapResponse> {
  const range = await viewRange(repo, "HEAD");
  if (!range) return empty();
  const view = { root: repo.root, ...range };
  const headRead = await readModelAt(repo.root, range.head);
  const reading = await readingOf(headRead, view);
  if (!headRead?.model) return noModel(headRead, reading);
  return drawMap(
    headRead.model,
    headRead,
    headRead.source === "local" ? null : headRead,
    await workingFileStats(repo),
    reading,
  );
}

function drawMap(
  model: Model,
  headRead: ModelRead,
  baseRead: ModelRead | null,
  stats: FileStat[],
  reading: Reading,
): MapResponse {
  const local = headRead.source === "local";
  // A base whose model comes from elsewhere than the head's isn't compared.
  const sameSource = baseRead?.source === headRead.source;
  const baseModel = sameSource ? (baseRead?.model ?? null) : null;

  // Files: each to its one leaf element. A deleted file maps by the base
  // model, where its element may still exist.
  const touched = new Map<string, ReturnType<typeof unchanged>>();
  const fileComponents: Record<string, string> = {};
  const unmapped: string[] = [];
  const ambiguous: { file: string; ids: string[] }[] = [];
  for (const f of stats) {
    const deleted = f.status === "D";
    const against = deleted && baseModel ? baseModel : model;
    if (!isAppCode(against, f.path)) continue;
    const ids = leafOf(against, f.path);
    if (ids.length === 0) {
      unmapped.push(f.path);
      continue;
    }
    if (ids.length > 1) {
      ambiguous.push({ file: f.path, ids });
      continue;
    }
    const entry = touched.get(ids[0]) ?? unchanged();
    entry.files.push(f.path);
    entry.fileStats.push({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    });
    entry.additions += f.additions;
    entry.deletions += f.deletions;
    if (f.status === "A") entry.newFiles++;
    touched.set(ids[0], entry);
    const name = against.elements.get(ids[0])?.name ?? ids[0];
    fileComponents[f.path] = name;
    if (f.oldPath !== f.path) fileComponents[f.oldPath] = name;
  }

  const added = baseModel
    ? [...model.elements.keys()].filter((id) => !baseModel.elements.has(id))
    : [];
  const removed = baseModel
    ? [...baseModel.elements.keys()].filter((id) => !model.elements.has(id))
    : [];

  const edges = new Map<string, MapEdge>();
  for (const [key, r] of model.relationships) {
    const old = baseModel?.relationships.get(key);
    edges.set(key, {
      key,
      source: r.source,
      destination: r.destination,
      description: r.description,
      ...(baseModel && !old
        ? { state: "added" as const }
        : old && old.description !== r.description
          ? { state: "changed" as const, before: old.description }
          : { state: "same" as const }),
    });
  }
  for (const [key, r] of baseModel?.relationships ?? []) {
    if (!model.relationships.has(key)) {
      edges.set(key, {
        key,
        source: r.source,
        destination: r.destination,
        description: r.description,
        state: "removed",
      });
    }
  }

  // An element whose only change is structural (it was added, or an arrow
  // changed) still counts as changed only if it's added or removed; an
  // arrow's ends are its neighbours.
  const changed = new Set([...touched.keys(), ...added, ...removed]);
  // Containers and systems that contain changed components are drawn as the
  // boxes around them, not as changed elements of their own.
  const elementOf = (id: string) =>
    model.elements.get(id) ?? baseModel?.elements.get(id);
  const parents = new Set(
    [...changed].flatMap((id) => ancestors(elementOf, id)),
  );
  for (const p of parents) changed.delete(p);

  // Neighbours, best first: the far end of a changed arrow always shows;
  // then whoever connects to the most changed elements. A hub such as Data
  // would otherwise bring in every component that reads it.
  const score = new Map<string, number>();
  for (const e of edges.values()) {
    for (const [end, other] of [
      [e.source, e.destination],
      [e.destination, e.source],
    ]) {
      if (changed.has(end) || parents.has(end)) continue;
      if (e.state !== "same") score.set(end, (score.get(end) ?? 0) + 100);
      else if (changed.has(other)) score.set(end, (score.get(end) ?? 0) + 1);
    }
  }
  const room = Math.max(0, MAX_NODES - changed.size);
  const ranked = [...score].sort((a, b) => b[1] - a[1]);
  const neighbours = new Set(
    ranked.filter(([, n], i) => n >= 100 || i < room).map(([id]) => id),
  );

  // Every container and system around a shown element is drawn too, as the
  // box it sits in.
  const shown = new Set([...changed, ...neighbours]);
  for (const id of [...shown])
    for (const p of ancestors(elementOf, id)) shown.add(p);
  const groups = new Set(
    [...shown].map((id) => elementOf(id)?.parent).filter(Boolean),
  );
  const nodes: MapNode[] = [...shown].map((id) => {
    const el = elementOf(id);
    const group = groups.has(id);
    const t = touched.get(id);
    return {
      id,
      name: el?.name ?? id,
      description: el?.description ?? "",
      type: el?.type ?? "component",
      state: removed.includes(id)
        ? "removed"
        : added.includes(id)
          ? "added"
          : t
            ? "touched"
            : "neighbour",
      parent: el?.parent && shown.has(el.parent) ? el.parent : null,
      group,
      files: t?.files ?? [],
      fileStats: t?.fileStats ?? [],
      additions: t?.additions ?? 0,
      deletions: t?.deletions ?? 0,
      newFiles: t?.newFiles ?? 0,
    };
  });

  const leaves = new Set(
    [...model.elements.values()]
      .filter((e) => e.type === "component" || e.globs.length > 0)
      .map((e) => e.id),
  );

  return {
    status: "ok",
    baseModel: baseModel !== null,
    error: null,
    baseError: sameSource ? (baseRead?.error ?? null) : null,
    source: headRead.source,
    local,
    modelFile: headRead.file,
    ...reading,
    nodes,
    edges: [...edges.values()].filter(
      (e) =>
        shown.has(e.source) &&
        shown.has(e.destination) &&
        !contains(elementOf, e.source, e.destination) &&
        !contains(elementOf, e.destination, e.source),
    ),
    ...(nodes.length === 0 ? { whole: wholeMap(model) } : {}),
    hidden: leaves.size - nodes.filter((n) => leaves.has(n.id)).length,
    fileComponents,
    unmapped,
    ambiguous,
    descriptions: Object.fromEntries(
      [...model.elements.values()].map((e) => [e.name, e.description]),
    ),
  };
}
