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
