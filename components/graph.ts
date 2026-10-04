/**
 * The layered layout the map and the data view share: each node's row is
 * the longest chain of arrows leading to it, so what points sits above what
 * it points at. Within a row, nodes follow the order of what points at them.
 * No library: a fixed layout of a dozen boxes doesn't need one.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  minW: number;
  maxW: number;
  rowGap: number;
  colGap: number;
  pad: number;
}

export function layeredLayout<N extends { id: string }>(
  nodes: N[],
  edges: { source: string; destination: string }[],
  width: number,
  height: (node: N, w: number) => number,
  o: LayoutOptions,
): { placed: Map<string, N & Box>; height: number } {
  const ids = nodes.map((n) => n.id);
  const into = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges)
    if (e.source !== e.destination) into.get(e.destination)?.push(e.source);

  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0; // a cycle: break it here
    visiting.add(id);
    const r = Math.max(-1, ...(into.get(id) ?? []).map(rankOf)) + 1;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of ids) rankOf(id);

  const rows: N[][] = [];
  for (const n of nodes) (rows[rank.get(n.id)!] ??= []).push(n);

  const placed = new Map<string, N & Box>();
  let y = o.pad;
  for (const row of rows.filter(Boolean)) {
    const pos = (n: N) => {
      const xs = (into.get(n.id) ?? [])
        .map((s) => placed.get(s))
        .filter(Boolean) as Box[];
      return xs.length
        ? xs.reduce((a, p) => a + p.x + p.w / 2, 0) / xs.length
        : Infinity;
    };
    row.sort((a, b) => pos(a) - pos(b));
    const perLine = Math.max(
      1,
      Math.min(
        row.length,
        Math.floor((width - 2 * o.pad + o.colGap) / (o.minW + o.colGap)),
      ),
    );
    for (let start = 0; start < row.length; start += perLine) {
      const line = row.slice(start, start + perLine);
      const w = Math.min(
        o.maxW,
        (width - 2 * o.pad - (line.length - 1) * o.colGap) / line.length,
      );
      const total = line.length * w + (line.length - 1) * o.colGap;
      let x = (width - total) / 2;
      const hs = line.map((n) => height(n, w));
      line.forEach((n, i) => {
        placed.set(n.id, { ...n, x, y, w, h: hs[i] });
        x += w + o.colGap;
      });
      y += Math.max(...hs) + o.rowGap;
    }
  }
  return { placed, height: y - o.rowGap + o.pad };
}

/**
 * An arrow from one box to another, leaving and arriving at evenly spread
 * points along the facing edges, so several arrows don't stack.
 */
export function edgePath(
  a: Box,
  b: Box,
  ai: number,
  an: number,
  bi: number,
  bn: number,
) {
  const ax = a.x + (a.w * (ai + 1)) / (an + 1);
  const bx = b.x + (b.w * (bi + 1)) / (bn + 1);
  if (b.y > a.y + a.h / 2) {
    const y1 = a.y + a.h;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return {
      d: `M${ax} ${y1} C${ax} ${mid} ${bx} ${mid} ${bx} ${y2 - 1}`,
      lx: (ax + bx) / 2,
      ly: mid,
    };
  }
  if (b.y + b.h < a.y + a.h / 2) {
    const y1 = a.y;
    const y2 = b.y + b.h;
    const mid = (y1 + y2) / 2;
    return {
      d: `M${ax} ${y1} C${ax} ${mid} ${bx} ${mid} ${bx} ${y2 + 1}`,
      lx: (ax + bx) / 2,
      ly: mid,
    };
  }
  // Same row: loop underneath.
  const y1 = a.y + a.h;
  const y2 = b.y + b.h;
  const dip = Math.max(y1, y2) + 28;
  return {
    d: `M${ax} ${y1} C${ax} ${dip} ${bx} ${dip} ${bx} ${y2 + 1}`,
    lx: (ax + bx) / 2,
    ly: dip - 6,
  };
}
