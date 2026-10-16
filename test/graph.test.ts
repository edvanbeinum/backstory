import assert from "node:assert/strict";
import { test } from "node:test";

import { type Box, edgePath, layeredLayout } from "../components/graph";

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

const inside = (x: number, y: number, b: Box) =>
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
  for (const b of boxes) assert.ok(!inside(lx, ly, b), `label in ${b.y}`);
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
  for (const b of boxes) assert.ok(!inside(up.lx, up.ly, b));
});

test("an arrow within one row loops underneath as before", () => {
  const a = box(0, 0);
  const b = box(300, 0);
  assert.deepEqual(
    edgePath(a, b, 0, 1, 0, 1, { boxes: [a, b, box(150, 124)], clearance: 11 }),
    edgePath(a, b, 0, 1, 0, 1),
  );
});
