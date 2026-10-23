import assert from "node:assert/strict";
import { test } from "node:test";

import {
  edgePath,
  layeredLayout,
  nestedLayout,
  type Box,
} from "../components/graph";

const arrows = (pairs: [string, string][]) =>
  pairs.map(([source, destination]) => ({ source, destination }));

test("layeredLayout without widthOf lays out as it did before nesting", () => {
  const o = { minW: 120, maxW: 200, rowGap: 30, colGap: 12, pad: 10 };
  const flat = layeredLayout(
    ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
    arrows([
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
      ["a", "e"],
      ["e", "f"],
      ["f", "a"],
    ]),
    500,
    (n, w) => 40 + (n.id.charCodeAt(0) % 3) * 10 + Math.round(w / 100),
    o,
  );
  assert.deepEqual(
    [...flat.placed.values()].map(({ id, x, y, w, h }) => [id, x, y, w, h]),
    [
      ["e", 150, 10, 200, 62],
      ["f", 150, 102, 200, 42],
      ["a", 150, 174, 200, 52],
      ["b", 44, 256, 200, 62],
      ["c", 256, 256, 200, 42],
      ["d", 150, 348, 200, 52],
    ],
  );
  assert.equal(flat.height, 410);

  const wrapped = layeredLayout(
    ["p", "q", "r", "s", "t"].map((id) => ({ id })),
    [],
    400,
    () => 30,
    o,
  );
  assert.deepEqual(
    [...wrapped.placed.values()].map(({ id, x, y, w, h }) => [id, x, y, w, h]),
    [
      ["p", 10, 10, 184, 30],
      ["q", 206, 10, 184, 30],
      ["r", 10, 70, 184, 30],
      ["s", 206, 70, 184, 30],
      ["t", 100, 130, 200, 30],
    ],
  );
  assert.equal(wrapped.height, 170);
});

const O = { minW: 190, maxW: 280, rowGap: 56, colGap: 18, pad: 14 };
const HEADER = 30;
const INSET = 12;

interface Node {
  id: string;
  parent: string | null;
  group: boolean;
}

const node = (id: string, parent: string | null, group = false): Node => ({
  id,
  parent,
  group,
});

const nested = (nodes: Node[], edges: [string, string][], width = 1400) =>
  nestedLayout(nodes, arrows(edges), width, () => 60, O, {
    header: HEADER,
    inset: INSET,
  });

const inside = (child: Box, group: Box) =>
  child.x >= group.x + INSET &&
  child.x + child.w <= group.x + group.w - INSET &&
  child.y >= group.y + HEADER &&
  child.y + child.h <= group.y + group.h - INSET;

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const SYSTEM = [
  node("person", null),
  node("app", null, true),
  node("app.web", "app", true),
  node("app.web.a", "app.web"),
  node("app.web.b", "app.web"),
  node("app.db", "app", true),
  node("app.db.c", "app.db"),
  node("app.db.d", "app.db"),
];

test("nestedLayout draws components inside their container, and containers inside their system", () => {
  const { placed, height } = nested(SYSTEM, [
    ["person", "app.web"],
    ["app.web.a", "app.db.c"],
  ]);
  const box = (id: string) => placed.get(id)!;
  for (const n of SYSTEM)
    if (n.parent)
      assert.ok(
        inside(box(n.id), box(n.parent)),
        `${n.id} sits inside ${n.parent}`,
      );
  for (const a of SYSTEM)
    for (const b of SYSTEM)
      if (a.id < b.id && a.parent === b.parent)
        assert.ok(!overlap(box(a.id), box(b.id)), `${a.id} and ${b.id}`);
  assert.ok(
    [...placed.values()].every((b) => b.y + b.h <= height),
    "the canvas is tall enough for every box",
  );
});

test("nestedLayout gives a container with one component a narrower box than one with four", () => {
  const { placed } = nested(
    [
      node("one", null, true),
      node("one.a", "one"),
      node("four", null, true),
      ...["a", "b", "c", "d"].map((k) => node(`four.${k}`, "four")),
    ],
    [],
    1600,
  );
  assert.ok(placed.get("one")!.w < placed.get("four")!.w);
  assert.ok(placed.get("one")!.w <= O.maxW + 2 * INSET);
});

test("nestedLayout ranks containers by the arrows between their components", () => {
  const { placed } = nested(
    [
      node("b", null, true),
      node("b.x", "b"),
      node("a", null, true),
      node("a.x", "a"),
    ],
    [["a.x", "b.x"]],
  );
  const a = placed.get("a")!;
  assert.ok(a.y + a.h <= placed.get("b")!.y);
});

test("an arrow to a container ends at the container's top edge", () => {
  const { placed } = nested(SYSTEM, [["person", "app.web"]]);
  const web = placed.get("app.web")!;
  const { d } = edgePath(placed.get("person")!, web, 0, 1, 0, 1);
  const end = Number(d.trim().split(" ").pop());
  assert.equal(end, web.y - 1);
});

const DATA_VIEW = { minW: 220, maxW: 300, rowGap: 64, colGap: 22, pad: 12 };

const box = (x: number, y: number, w = 200, h = 60): Box => ({ x, y, w, h });

/**
 * Splits a path into its segments, each as the points it spans. A cubic
 * Bézier stays inside the hull of its four points, so a segment whose points'
 * bounding box misses a box never enters it.
 */
function segments(d: string): [number, number][][] {
  const out: [number, number][][] = [];
  let pen: [number, number] = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = args.trim().split(/\s+/).map(Number);
    const pts: [number, number][] = [];
    for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    if (cmd !== "M") out.push([pen, ...pts]);
    pen = pts[pts.length - 1];
  }
  return out;
}

function assertClear(d: string, boxes: Box[]) {
  for (const seg of segments(d)) {
    const xs = seg.map((p) => p[0]);
    const ys = seg.map((p) => p[1]);
    for (const b of boxes) {
      const overlaps =
        Math.max(...xs) > b.x &&
        Math.min(...xs) < b.x + b.w &&
        Math.max(...ys) > b.y &&
        Math.min(...ys) < b.y + b.h;
      assert.ok(
        !overlaps,
        `${JSON.stringify(seg)} crosses ${JSON.stringify(b)}`,
      );
    }
  }
}

const pointIn = (x: number, y: number, b: Box) =>
  x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;

/** The x of every vertical run, in order. */
const runs = (d: string) =>
  segments(d)
    .filter((s) => s.length === 2 && s[0][0] === s[1][0])
    .map((s) => s[0][0]);

test("an arrow that skips a row goes around the card between and labels the gap above its destination", () => {
  const nodes = ["CollectionItem", "Collection", "Account", "Tag"].map(
    (id) => ({ id }),
  );
  const edges = [
    ["CollectionItem", "Collection"],
    ["CollectionItem", "Account"],
    ["Collection", "Account"],
    ["Collection", "Tag"],
  ].map(([source, destination]) => ({ source, destination }));
  const { placed } = layeredLayout(nodes, edges, 1440, () => 64, DATA_VIEW);
  const at = (id: string) => placed.get(id)!;
  assert.ok(at("CollectionItem").y < at("Collection").y);
  assert.ok(at("Collection").y < at("Account").y);
  assert.equal(at("Account").y, at("Tag").y);

  const boxes = [...placed.values()];
  const { d, lx, ly } = edgePath(
    at("CollectionItem"),
    at("Account"),
    0,
    2,
    0,
    2,
    {
      boxes,
      clearance: DATA_VIEW.colGap / 2,
    },
  );
  assertClear(d, boxes);
  for (const b of boxes) assert.ok(!pointIn(lx, ly, b), `label in ${b.y}`);
  assert.ok(
    ly > at("Collection").y + at("Collection").h && ly < at("Account").y,
  );
});

test("an arrow with no card in the way draws as it did without around", () => {
  const a = box(100, 0);
  const b = box(300, 124);
  const plain = edgePath(a, b, 0, 1, 0, 1);
  assert.deepEqual(
    edgePath(a, b, 0, 1, 0, 1, { boxes: [a, b, box(400, 0)], clearance: 11 }),
    plain,
  );
  assert.deepEqual(
    edgePath(b, a, 0, 1, 0, 1, { boxes: [a, b], clearance: 11 }),
    edgePath(b, a, 0, 1, 0, 1),
  );
});

test("a card between the ends but off to the side is passed without a jog", () => {
  const a = box(100, 0);
  const side = box(500, 124);
  const b = box(100, 248);
  const { d } = edgePath(a, b, 0, 1, 0, 1, {
    boxes: [a, side, b],
    clearance: 11,
  });
  assert.deepEqual(runs(d), [200]);
  assertClear(d, [a, side, b]);
});

test("a run within clearance of a card's edge steps aside too", () => {
  const a = box(100, 0);
  const edge = box(205, 124);
  const { d } = edgePath(a, box(0, 248), 0, 1, 0, 1, {
    boxes: [edge],
    clearance: 11,
  });
  assert.deepEqual(runs(d), [194]);
});

test("a run on the edge of a card's clearance, give or take rounding, keeps its line", () => {
  const a = box(100, 0);
  const next = box(211 - 1e-12, 124);
  const { d } = edgePath(a, box(300, 248), 0, 1, 0, 1, {
    boxes: [next],
    clearance: 11,
  });
  assert.deepEqual(runs(d), [200]);
});

test("the jog goes to the side of the card nearer the destination", () => {
  const a = box(100, 0);
  const mid = box(100, 124);
  const left = edgePath(a, box(0, 248), 0, 1, 0, 1, {
    boxes: [mid],
    clearance: 11,
  });
  assert.deepEqual(runs(left.d), [89]);
  const right = edgePath(a, box(250, 248), 0, 1, 0, 1, {
    boxes: [mid],
    clearance: 11,
  });
  assert.deepEqual(runs(right.d), [311]);
});

test("an arrow over three rows steps around each card and labels the last gap", () => {
  const a = box(100, 0);
  const one = box(100, 124);
  const two = box(250, 248);
  const b = box(300, 372);
  const boxes = [a, one, two, b];
  const { d, lx, ly } = edgePath(a, b, 0, 1, 0, 1, { boxes, clearance: 11 });
  assert.deepEqual(runs(d), [311, 461]);
  assertClear(d, boxes);
  assert.ok(ly > two.y + two.h && ly < b.y);
  assert.equal(lx, (461 + 400) / 2);
});

test("a card on an earlier line of the destination's row is in the way", () => {
  const { placed } = layeredLayout(
    ["top", "x", "y", "z"].map((id) => ({ id })),
    ["x", "y", "z"].map((destination) => ({ source: "top", destination })),
    500,
    () => 64,
    DATA_VIEW,
  );
  const boxes = [...placed.values()];
  const z = placed.get("z")!;
  const earlier = boxes.filter((p) => p.y > placed.get("top")!.y && p.y < z.y);
  assert.ok(earlier.length > 0, "the row wraps");
  const { d } = edgePath(placed.get("top")!, z, 0, 2, 0, 1, {
    boxes,
    clearance: 11,
  });
  assert.equal(runs(d).length, 1);
  assertClear(d, boxes);
});

test("an upward arrow steps around the card between too", () => {
  const a = box(100, 248);
  const mid = box(100, 124);
  const b = box(100, 0);
  const boxes = [a, mid, b];
  const { d, ly } = edgePath(a, b, 0, 1, 0, 1, { boxes, clearance: 11 });
  assert.equal(runs(d).length, 1);
  assertClear(d, boxes);
  assert.ok(ly > b.y + b.h && ly < mid.y);
});

test("a bend stays clear of a taller card beside either end", () => {
  const top = box(100, 0, 200, 36);
  const tall = box(322, 0, 200, 300);
  const mid = box(150, 364, 200, 60);
  const low = box(400, 488, 200, 60);
  const boxes = [top, tall, mid, low];
  const down = edgePath(top, low, 0, 1, 0, 1, { boxes, clearance: 11 });
  assert.deepEqual(runs(down.d), [200, 361]);
  assertClear(down.d, boxes);
  const up = edgePath(low, top, 0, 1, 0, 1, { boxes, clearance: 11 });
  assertClear(up.d, boxes);
  for (const b of boxes) assert.ok(!pointIn(up.lx, up.ly, b));
});

test("an arrow within one row loops underneath as before", () => {
  const a = box(0, 0);
  const b = box(300, 0);
  assert.deepEqual(
    edgePath(a, b, 0, 1, 0, 1, { boxes: [a, b, box(150, 124)], clearance: 11 }),
    edgePath(a, b, 0, 1, 0, 1),
  );
});
