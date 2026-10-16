import { autoRead } from "./data/cache";
import { git } from "./exec";
import {
  isAppCode,
  localModelFile,
  readModelAt,
  type Model,
  type ModelSource,
} from "./model";
import { mapSpentUsd, mapStatus, type MapDraftStatus } from "./models/cache";

/**
 * The system map for a view: which C4 elements the change touched, which
 * the model gained or lost, and how the arrows between them changed. Compared
 * by DSL identifier, with Archify's rules (https://github.com/tt-a1i/archify,
 * MIT): an element is added or removed by its identifier; an arrow by its two
 * ends, so a new label on the same pair reads as changed.
 *
 * Focused on the change: the changed elements and their direct neighbours.
 * A drafted map is compared like a committed one, base with head.
 */

export type NodeState = "touched" | "added" | "removed" | "neighbour";
export type EdgeState = "added" | "removed" | "changed" | "same";

export interface MapNode {
  id: string;
  name: string;
  description: string;
  type: string;
  state: NodeState;
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
  /** The day the drafted map was read, when it's drafted */
  drafted: string | null;
  /** The view's map read, when the repo has no model of its own */
  draft?: MapDraftStatus;
  /** On a drafted map: the dollars spent drafting this repo's maps */
  spentUsd?: number;
  /** When the repo has no model of its own: whether maps are read as repos and views open */
  auto?: boolean;
  /** When the repo has no model of its own: where a hand-written local model goes */
  handFile?: string;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Every component, person and external system, unchanged, when the change touches none */
  whole?: { nodes: MapNode[]; edges: MapEdge[] };
  /** Elements in the model that the focused map leaves out */
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

async function fileStats(
  root: string,
  base: string | null,
  head: string,
): Promise<FileStat[]> {
  const range = base
    ? [base, head]
    : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", head];
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

const leafOf = (model: Model, file: string) => model.match(file);

/**
 * The whole system, for Show map: every element nothing sits inside (each
 * component, person and external system), unchanged, with every explicit
 * arrow between them.
 */
function wholeMap(model: Model): { nodes: MapNode[]; edges: MapEdge[] } {
  const parents = new Set(
    [...model.elements.values()].map((e) => e.parent).filter(Boolean),
  );
  const nodes: MapNode[] = [...model.elements.values()]
    .filter((e) => !parents.has(e.id))
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      type: e.type,
      state: "neighbour",
      files: [],
      fileStats: [],
      additions: 0,
      deletions: 0,
      newFiles: 0,
    }));
  const shown = new Set(nodes.map((n) => n.id));
  const edges: MapEdge[] = [...model.relationships.values()]
    .filter((r) => shown.has(r.source) && shown.has(r.destination))
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

export async function buildMap(
  root: string,
  base: string | null,
  head: string,
): Promise<MapResponse> {
  const headRead = await readModelAt(root, head);
  const empty: MapResponse = {
    status: "none",
    baseModel: false,
    error: null,
    baseError: null,
    local: false,
    modelFile: null,
    drafted: null,
    nodes: [],
    edges: [],
    hidden: 0,
    fileComponents: {},
    unmapped: [],
    ambiguous: [],
    descriptions: {},
  };
  // With no model of its own, the repo's map is drafted: say how its read
  // for this view stands.
  const drafting = !headRead || headRead.source === "drafted";
  const reading = drafting
    ? {
        draft: await mapStatus({ root, base, head }),
        auto: autoRead(),
        handFile: await localModelFile(root),
      }
    : {};
  if (!headRead) return { ...empty, ...reading };
  const local = headRead.source === "local";
  if (!headRead.model)
    return {
      ...empty,
      source: headRead.source,
      error: headRead.error,
      local,
      modelFile: headRead.file,
    };
  const model = headRead.model;
  // A local model is the same for every commit; comparing it with itself
  // would claim "no structural change" when nothing was checked. A base
  // whose model comes from elsewhere than the head's isn't compared either.
  const baseRead = base && !local ? await readModelAt(root, base) : null;
  const sameSource = baseRead?.source === headRead.source;
  const baseModel = sameSource ? (baseRead?.model ?? null) : null;

  // Files: each to its one leaf element. A deleted file maps by the base
  // model, where its element may still exist.
  const touched = new Map<
    string,
    {
      files: string[];
      fileStats: MapNode["fileStats"];
      additions: number;
      deletions: number;
      newFiles: number;
    }
  >();
  const fileComponents: Record<string, string> = {};
  const unmapped: string[] = [];
  const ambiguous: { file: string; ids: string[] }[] = [];
  for (const f of await fileStats(root, base, head)) {
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
    const entry = touched.get(ids[0]) ?? {
      files: [],
      fileStats: [],
      additions: 0,
      deletions: 0,
      newFiles: 0,
    };
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
  // Containers and systems that hold changed components aren't drawn twice.
  const parents = new Set<string>();
  for (const id of changed) {
    for (
      let p = (model.elements.get(id) ?? baseModel?.elements.get(id))?.parent;
      p;
    ) {
      parents.add(p);
      p = (model.elements.get(p) ?? baseModel?.elements.get(p))?.parent ?? null;
    }
  }
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

  const shown = new Set([...changed, ...neighbours]);
  const nodes: MapNode[] = [...shown].map((id) => {
    const el = model.elements.get(id) ?? baseModel?.elements.get(id);
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
      files: t?.files ?? [],
      fileStats: t?.fileStats ?? [],
      additions: t?.additions ?? 0,
      deletions: t?.deletions ?? 0,
      newFiles: t?.newFiles ?? 0,
    };
  });

  const leaves = [...model.elements.values()].filter(
    (e) => e.type === "component" || e.globs.length > 0,
  ).length;

  return {
    status: "ok",
    baseModel: baseModel !== null,
    error: null,
    baseError: sameSource ? (baseRead?.error ?? null) : null,
    source: headRead.source,
    local,
    modelFile: headRead.file,
    drafted: headRead.drafted,
    ...reading,
    ...(headRead.source === "drafted"
      ? { spentUsd: await mapSpentUsd(root) }
      : {}),
    nodes,
    edges: [...edges.values()].filter(
      (e) => shown.has(e.source) && shown.has(e.destination),
    ),
    ...(nodes.length === 0 ? { whole: wholeMap(model) } : {}),
    hidden: Math.max(
      0,
      leaves - nodes.filter((n) => n.state !== "removed").length,
    ),
    fileComponents,
    unmapped,
    ambiguous,
    descriptions: Object.fromEntries(
      [...model.elements.values()].map((e) => [e.name, e.description]),
    ),
  };
}
