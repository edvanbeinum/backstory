import { mapLayout } from "../components/mapLayout";
import type { EntityDiff, DataResponse } from "./data/types";
import type { ChangeDescription } from "./description/types";
import { stepMarks, type StepMark } from "./flows/rows";
import type { FlowSet } from "./flows/types";
import type { MapNode, MapResponse } from "./map";
import { ownsCode } from "./mapGroups";
import type { DiffFile } from "./types";

/**
 * Story's walk: the change as a row of stops, read one at a time. An
 * overview, the data model when it changed, one stop per changed component
 * in the map's order, the files no component has, and a finish. Every
 * changed file is in exactly one stop, so seeing every stop is seeing the
 * whole change.
 */

type WalkFile = Pick<DiffFile, "path" | "oldPath" | "newPath">;

export type Stop<F extends WalkFile = DiffFile> = {
  key: string;
  files: F[];
} & (
  | { kind: "overview" }
  | { kind: "data"; entities: EntityDiff[] }
  | {
      kind: "component";
      node: MapNode;
      /** The name of the container or system it's drawn inside */
      container: string | null;
      /** The description's sentence on it, or the map's description of it */
      sentence: string;
      /** The flow steps its files are on, in flow and step order */
      steps: StepMark[];
      /** Its arrows on the map, by key */
      edges: string[];
    }
  | { kind: "yourself" }
  | { kind: "finish" }
);

/**
 * The width the walk lays the map out at to order its components. The map
 * on screen is laid out at the column's width, which only moves a box to a
 * new line within its rank, so reading order is the same.
 */
const ORDER_WIDTH = 1200;

/** Changed components top to bottom, then left to right, as the map draws them. */
function mapOrder(map: MapResponse, nodes: MapNode[]): MapNode[] {
  const { placed } = mapLayout(map.nodes, map.edges, ORDER_WIDTH);
  const at = (n: MapNode) => placed.get(n.id) ?? { x: 0, y: Infinity };
  return [...nodes].sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x);
}

/** The flow steps on any of these files, each once. */
function stepsOn(
  marks: ReturnType<typeof stepMarks> | null,
  files: WalkFile[],
): StepMark[] {
  if (!marks) return [];
  const found = new Map<string, StepMark>();
  for (const file of files)
    for (const path of new Set([file.newPath, file.oldPath]))
      if (path)
        for (const side of Object.values(marks.get(path) ?? {}))
          for (const list of side.values())
            for (const mark of list) found.set(mark.key, mark);
  return [...found.values()].sort((a, b) => a.flow - b.flow || a.step - b.step);
}

export function buildStops<F extends WalkFile>({
  description,
  map,
  data,
  flows,
  files,
}: {
  description: ChangeDescription | null;
  map: MapResponse | null;
  data: DataResponse | null;
  flows: FlowSet | null;
  files: F[];
}): Stop<F>[] {
  const stops: Stop<F>[] = [{ kind: "overview", key: "overview", files: [] }];

  const entities =
    data?.status === "ok"
      ? data.entities.filter((e) => e.state !== "same")
      : [];
  if (entities.length > 0)
    stops.push({ kind: "data", key: "data", files: [], entities });

  const held = new Set<F>();
  if (map?.status === "ok") {
    const owners = map.nodes.filter((n) => ownsCode(n) && n.files.length > 0);
    const byName = new Map(owners.map((n) => [n.name, n]));
    const filesOf = new Map<MapNode, F[]>();
    for (const file of files) {
      const name =
        (file.newPath && map.fileComponents[file.newPath]) ||
        (file.oldPath && map.fileComponents[file.oldPath]) ||
        null;
      const node = name ? byName.get(name) : undefined;
      if (!node) continue;
      filesOf.set(node, [...(filesOf.get(node) ?? []), file]);
      held.add(file);
    }
    const marks = flows ? stepMarks(flows) : null;
    const nameOf = new Map(map.nodes.map((n) => [n.id, n.name]));
    for (const node of mapOrder(map, [...filesOf.keys()])) {
      const own = filesOf.get(node)!;
      stops.push({
        kind: "component",
        key: `component:${node.id}`,
        files: own,
        node,
        container: node.parent ? (nameOf.get(node.parent) ?? null) : null,
        sentence:
          description?.components.find((c) => c.name === node.name)?.sentence ??
          (node.description || map.descriptions[node.name] || ""),
        steps: stepsOn(marks, own),
        edges: map.edges
          .filter((e) => e.source === node.id || e.destination === node.id)
          .map((e) => e.key),
      });
    }
  }

  const rest = files.filter((f) => !held.has(f));
  if (rest.length > 0)
    stops.push({ kind: "yourself", key: "yourself", files: rest });

  stops.push({ kind: "finish", key: "finish", files: [] });
  return stops;
}

/** How many of the walk's files are in the stops seen so far, by key. */
export function filesSeen(stops: Stop<WalkFile>[], seen: Set<string>) {
  return stops
    .filter((s) => seen.has(s.key))
    .reduce((n, s) => n + s.files.length, 0);
}

/** Every file in a stop not seen yet, in the walk's order. */
export function filesNotSeen<F extends WalkFile>(
  stops: Stop<F>[],
  seen: Set<string>,
): F[] {
  return stops.filter((s) => !seen.has(s.key)).flatMap((s) => s.files);
}
