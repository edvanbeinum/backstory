import type { MapNode } from "./map";

/**
 * The map's components as the page groups by them. Kept apart from
 * `lib/map.ts`, which runs git, so the page can import it.
 */

export interface ComponentGroup<F> {
  /** The component's name; null for "Not on the map" */
  component: string | null;
  files: F[];
}

/**
 * Whether a node counts as a component of its own: a leaf box, or a
 * container drawn around others whose own files the change touched.
 */
export const ownsCode = (n: Pick<MapNode, "group" | "files">) =>
  !n.group || n.files.length > 0;

/**
 * Changed files under the components they belong to, in the map's order,
 * with the files no component holds last, so the diff reads in the order
 * the map does. Every file lands in exactly one group.
 */
export function groupByComponent<F extends { path: string }>(
  files: F[],
  fileComponents: Record<string, string>,
  nodes: Pick<MapNode, "name">[],
): ComponentGroup<F>[] {
  const order = new Map(nodes.map((n, i) => [n.name, i]));
  const groups = new Map<string | null, F[]>();
  for (const f of files) {
    const component = fileComponents[f.path] ?? null;
    groups.set(component, [...(groups.get(component) ?? []), f]);
  }
  const rank = (c: string | null) =>
    c === null ? Infinity : (order.get(c) ?? nodes.length);
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([component, files]) => ({ component, files }));
}
