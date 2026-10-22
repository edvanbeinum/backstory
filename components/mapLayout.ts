import type { MapEdge, MapNode } from "@/lib/map";
import { nestedLayout } from "./graph";

/**
 * Where the map draws each box: the C4 view's sizes on `nestedLayout`. Kept
 * apart from `SystemMap.tsx`, so Story's walk can follow the same order
 * without importing the map's component.
 */

const ROW_GAP = 56;
const MIN_NODE_W = 190;
const MAX_NODE_W = 280;
/** Files named in a box before the rest fold into "+N more". */
export const MAX_FILES = 4;
const COL_GAP = 18;
const PAD = 14;
/** A container's or system's box: the header above its children, and the space around them. */
export const GROUP_HEADER = 32;
const GROUP_INSET = 12;

/**
 * A box's height before it's measured: name, the description wrapped, and
 * one line per file named. The real height replaces it after the first paint.
 */
function estimateHeight(n: MapNode, w: number) {
  const inner = w - 24;
  const descLines = n.description
    ? Math.ceil((n.description.length * 6.4) / inner)
    : 0;
  const nameLines = Math.ceil(
    (n.name.length * 7.6 +
      (n.state === "added" || n.state === "removed" ? 60 : 0)) /
      inner,
  );
  const files = Math.min(n.files.length, MAX_FILES + 1);
  const foot = n.state === "touched" || n.state === "added" ? 24 : 0;
  return (
    16 + nameLines * 18 + descLines * 16 + (files ? 8 + files * 18 : 0) + foot
  );
}

export function mapLayout(
  nodes: MapNode[],
  edges: MapEdge[],
  width: number,
  heights: Map<string, number> = new Map(),
) {
  return nestedLayout(
    nodes,
    edges,
    width,
    (n, w) => heights.get(n.id) ?? estimateHeight(n, w),
    {
      minW: MIN_NODE_W,
      maxW: MAX_NODE_W,
      rowGap: ROW_GAP,
      colGap: COL_GAP,
      pad: PAD,
    },
    { header: GROUP_HEADER, inset: GROUP_INSET },
  );
}
