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

interface LayoutOptions {
  minW: number;
  maxW: number;
  rowGap: number;
  colGap: number;
  pad: number;
}

type Edge = { source: string; destination: string };
type Laid<N> = { placed: Map<string, N & Box>; height: number };

function arrowsInto(ids: string[], edges: Edge[]) {
  const into = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges)
    if (e.source !== e.destination) into.get(e.destination)?.push(e.source);
  return into;
}

function ranks(ids: string[], into: Map<string, string[]>) {
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
  return rank;
}

/**
 * `widthOf` gives a node a preferred width, kept up to the width available.
 * Nodes without one share what's left of their line, at most `maxW` each,
 * and a line takes as many nodes as fit at `minW`.
 */
export function layeredLayout<N extends { id: string }>(
  nodes: N[],
  edges: Edge[],
  width: number,
  height: (node: N, w: number) => number,
  o: LayoutOptions,
  widthOf: (node: N, available: number) => number | undefined = () => undefined,
): Laid<N> {
  const ids = nodes.map((n) => n.id);
  const into = arrowsInto(ids, edges);
  const rank = ranks(ids, into);

  const rows: N[][] = [];
  for (const n of nodes) (rows[rank.get(n.id)!] ??= []).push(n);

  const available = width - 2 * o.pad;
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
    const kept = row.map((n) => {
      const w = widthOf(n, available);
      return w === undefined ? undefined : Math.min(w, available);
    });
    for (let start = 0; start < row.length;) {
      let end = start + 1;
      let used = kept[start] ?? o.minW;
      while (
        end < row.length &&
        used + o.colGap + (kept[end] ?? o.minW) <= available
      )
        used += o.colGap + (kept[end++] ?? o.minW);
      const line = row.slice(start, end);
      const fixed = kept.slice(start, end);
      const share = Math.min(
        o.maxW,
        (available -
          fixed.reduce<number>((a, w) => a + (w ?? 0), 0) -
          (line.length - 1) * o.colGap) /
          fixed.filter((w) => w === undefined).length,
      );
      const ws = fixed.map((w) => w ?? share);
      const total =
        ws.reduce((a, w) => a + w, 0) + (line.length - 1) * o.colGap;
      let x = (width - total) / 2;
      const hs = line.map((n, i) => height(n, ws[i]));
      line.forEach((n, i) => {
        placed.set(n.id, { ...n, x, y, w: ws[i], h: hs[i] });
        x += ws[i] + o.colGap;
      });
      y += Math.max(...hs) + o.rowGap;
      start = end;
    }
  }
  return { placed, height: y - o.rowGap + o.pad };
}

interface Around {
  boxes: Box[];
  clearance: number;
}

/**
 * Boxes inside boxes, for the map's C4 view: each level is a
 * `layeredLayout`, and a group's children are laid out inside it, below its
 * header. A level is ranked by the arrows between the boxes their ends sit
 * in at that level, so a component's arrow to another container's component
 * puts its own container above that one.
 */
export function nestedLayout<
  N extends { id: string; parent: string | null; group: boolean },
>(
  nodes: N[],
  edges: Edge[],
  width: number,
  height: (node: N, w: number) => number,
  o: LayoutOptions,
  { header, inset }: { header: number; inset: number },
): Laid<N> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = (n: N) =>
    n.parent !== null && byId.has(n.parent) ? n.parent : null;
  const children = new Map<string | null, N[]>();
  for (const n of nodes) {
    const p = parentOf(n);
    children.set(p, [...(children.get(p) ?? []), n]);
  }
  // The ancestor of `id`, or `id` itself, that sits directly in `level`.
  const at = (id: string, level: string | null): string | null => {
    for (let n = byId.get(id); n;) {
      const p = parentOf(n);
      if (p === level) return n.id;
      if (p === null) return null;
      n = byId.get(p);
    }
    return null;
  };
  const lifted = new Map<string | null, Edge[]>();
  const edgesIn = (level: string | null) => {
    if (!lifted.has(level))
      lifted.set(
        level,
        edges.flatMap((e) => {
          const source = at(e.source, level);
          const destination = at(e.destination, level);
          return source && destination && source !== destination
            ? [{ source, destination }]
            : [];
        }),
      );
    return lifted.get(level)!;
  };

  // The width that fits a group's widest row side by side, leaves at `maxW`.
  const natural = new Map<string, number>();
  const naturalWidth = (g: N): number => {
    if (natural.has(g.id)) return natural.get(g.id)!;
    const kids = children.get(g.id) ?? [];
    const ids = kids.map((k) => k.id);
    const rank = ranks(ids, arrowsInto(ids, edgesIn(g.id)));
    const rows = new Map<number, number[]>();
    for (const k of kids) {
      const r = rank.get(k.id)!;
      rows.set(r, [...(rows.get(r) ?? []), k.group ? naturalWidth(k) : o.maxW]);
    }
    const widest = Math.max(
      o.minW,
      ...[...rows.values()].map(
        (ws) => ws.reduce((a, w) => a + w, 0) + (ws.length - 1) * o.colGap,
      ),
    );
    natural.set(g.id, widest + 2 * inset);
    return widest + 2 * inset;
  };

  // Each call starts a new cache: measured heights change between calls,
  // and a group's size depends on its children's.
  const inside = { ...o, pad: 0 };
  const cache = new Map<string, Laid<N>>();
  const level = (parent: string | null, w: number): Laid<N> => {
    const key = `${parent}\n${w}`;
    let laid = cache.get(key);
    if (!laid) {
      laid = layeredLayout(
        children.get(parent) ?? [],
        edgesIn(parent),
        w,
        (n, nw) =>
          n.group
            ? header + level(n.id, nw - 2 * inset).height + inset
            : height(n, nw),
        parent === null ? o : inside,
        (n) => (n.group ? naturalWidth(n) : undefined),
      );
      cache.set(key, laid);
    }
    return laid;
  };

  const placed = new Map<string, N & Box>();
  const place = (parent: string | null, w: number, dx: number, dy: number) => {
    for (const b of level(parent, w).placed.values()) {
      placed.set(b.id, { ...b, x: b.x + dx, y: b.y + dy });
      if (b.group)
        place(b.id, b.w - 2 * inset, b.x + dx + inset, b.y + dy + header);
    }
  };
  place(null, width, 0, 0);
  return { placed, height: level(null, width).height };
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
    const left = c.x - clearance;
    const right = c.x + c.w + clearance;
    // Treat a run on the edge of a card's clearance, give or take rounding, as
    // clear of it: the middle of a column gap is that edge for the cards on
    // both sides, and a run stepped into one row's gap lands on it in the next.
    if (c.y < y || x <= left + 1e-6 || x >= right - 1e-6) continue;
    curve(Math.abs(left - bx) <= Math.abs(right - bx) ? left : right, c.y, c.y);
    y = c.y + c.h;
    d += ` L${at(x, y)}`;
  }
  const lx = (x + bx) / 2;
  const mid = curve(bx, y2, y2 - 1);
  return { d, lx, ly: flip * mid };
}
