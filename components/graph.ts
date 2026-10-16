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

export interface Around {
  boxes: Box[];
  clearance: number;
}

/**
 * An arrow from one box to another, leaving and arriving at evenly spread
 * points along the facing edges, so several arrows don't stack. Given
 * `around`, an arrow that spans rows steps aside of each box between its
 * ends, `clearance` past the box's edge, and puts its label in the gap
 * above its destination, so it never runs behind a card or labels a field.
 */
export function edgePath(
  a: Box,
  b: Box,
  ai: number,
  an: number,
  bi: number,
  bn: number,
  around?: Around,
) {
  const ax = a.x + (a.w * (ai + 1)) / (an + 1);
  const bx = b.x + (b.w * (bi + 1)) / (bn + 1);
  if (b.y > a.y + a.h / 2) return descend(ax, a.y + a.h, bx, b.y, around, 1);
  if (b.y + b.h < a.y + a.h / 2)
    return descend(ax, -a.y, bx, -(b.y + b.h), around, -1);
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

/**
 * Routes an arrow downward from (ax, y1) to (bx, y2) as vertical runs joined
 * by S-curves, each curve bending in the gap above the next box it steps
 * around. `flip` -1 mirrors an upward arrow into this frame: the caller
 * passes negated ys and every point negates back on the way out.
 */
function descend(
  ax: number,
  y1: number,
  bx: number,
  y2: number,
  around: Around | undefined,
  flip: 1 | -1,
) {
  const boxes = (around?.boxes ?? []).map((c) =>
    flip === 1 ? c : { ...c, y: -(c.y + c.h) },
  );
  const inWay = boxes
    .filter((c) => c.y >= y1 && c.y + c.h <= y2)
    .sort((p, q) => p.y - q.y);
  const clearance = around?.clearance ?? 0;
  const at = (x: number, y: number) => `${x} ${flip * y}`;

  let x = ax;
  let y = y1;
  let d = `M${at(ax, y1)}`;
  // Bend in the gap just above `top`, clear of every box the curve sweeps
  // across: below those ending above it and above those starting in it. A
  // taller card beside either end reaches into that gap, so the bend can't
  // be measured from the end's own box.
  const curve = (nx: number, top: number, end: number) => {
    const across = boxes.filter(
      (c) => c.x < Math.max(x, nx) && c.x + c.w > Math.min(x, nx),
    );
    const from = Math.max(
      y1,
      ...inWay.map((c) => c.y + c.h).filter((bottom) => bottom <= top),
      ...across.map((c) => c.y + c.h).filter((bottom) => bottom <= top),
    );
    const to = Math.min(
      top,
      ...across.map((c) => c.y).filter((t) => t >= from),
    );
    if (from > y) d += ` L${at(x, from)}`;
    const mid = (from + to) / 2;
    d += ` C${at(x, mid)} ${at(nx, mid)} ${at(nx, Math.min(to, end))}`;
    if (end > to) d += ` L${at(nx, end)}`;
    x = nx;
    return mid;
  };

  for (const c of inWay) {
    if (c.y < y || x <= c.x - clearance || x >= c.x + c.w + clearance) continue;
    const left = c.x - clearance;
    const right = c.x + c.w + clearance;
    curve(Math.abs(left - bx) <= Math.abs(right - bx) ? left : right, c.y, c.y);
    y = c.y + c.h;
    d += ` L${at(x, y)}`;
  }
  const lx = (x + bx) / 2;
  const mid = curve(bx, y2, y2 - 1);
  return { d, lx, ly: flip * mid };
}
