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
      /** The records its steps read or write, by their data tags, in flow and step order */
      uses: string[];
    }
  | { kind: "yourself" }
  | { kind: "finish" }
);

/**
 * Changed components in the map's reading order: the ids the map reports,
 * then any it hasn't placed yet in the map's own order.
 */
function mapOrder(order: string[] | null, nodes: MapNode[]): MapNode[] {
  const rank = new Map((order ?? []).map((id, i) => [id, i]));
  const at = (n: MapNode) => rank.get(n.id) ?? Infinity;
  return [...nodes].sort((a, b) => at(a) - at(b));
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

/** The entities the after side's steps on any of these files tag, each once. */
function usesOn(flows: FlowSet | null, files: WalkFile[]): string[] {
  const paths = new Set(files.flatMap((f) => [f.newPath, f.oldPath]));
  const names = new Set<string>();
  for (const flow of flows?.flows ?? [])
    for (const step of flow.after)
      if (paths.has(step.file))
        for (const d of step.data ?? []) names.add(d.entity);
  return [...names];
}

export function buildStops<F extends WalkFile>({
  description,
  map,
  order,
  data,
  flows,
  files,
}: {
  description: ChangeDescription | null;
  map: MapResponse | null;
  /** The map's box ids top to bottom, then left to right, as it's drawn; null until it's drawn */
  order: string[] | null;
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
    for (const node of mapOrder(
      order,
      owners.filter((n) => filesOf.has(n)),
    )) {
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
        uses: usesOn(flows, own),
      });
    }
  }

  const rest = files.filter((f) => !held.has(f));
  if (rest.length > 0)
    stops.push({ kind: "yourself", key: "yourself", files: rest });

  stops.push({ kind: "finish", key: "finish", files: [] });
  return stops;
}

/** Every file in a stop not seen yet, in the walk's order. */
export function filesNotSeen<F extends WalkFile>(
  stops: Stop<F>[],
  seen: Set<string>,
): F[] {
  return stops.filter((s) => !seen.has(s.key)).flatMap((s) => s.files);
}
