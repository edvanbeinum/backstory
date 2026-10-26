import assert from "node:assert/strict";
import { test } from "node:test";

import type { DataResponse, EntityDiff } from "../lib/data/types";
import type { ChangeDescription } from "../lib/description/types";
import type { FlowSet, FlowStep } from "../lib/flows/types";
import type { MapNode, MapResponse } from "../lib/map";
import type { DiffFile } from "../lib/types";
import { buildStops, filesNotSeen } from "../lib/walk";

const file = (path: string, oldPath: string | null = path): DiffFile => ({
  oldPath,
  newPath: path,
  path,
  status: oldPath && oldPath !== path ? "renamed" : "modified",
  isBinary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
  lang: null,
});

const node = (
  id: string,
  files: string[],
  extra: Partial<MapNode> = {},
): MapNode => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  description: `What ${id} does`,
  type: "component",
  state: files.length ? "touched" : "neighbour",
  parent: null,
  group: false,
  files,
  fileStats: [],
  additions: files.length,
  deletions: 0,
  newFiles: 0,
  ...extra,
});

/**
 * Three changed components: Screen and Api inside the App container, Screen
 * pointing at Api, and Store below them both. Screen has a file renamed.
 */
const MAP: MapResponse = {
  status: "ok",
  baseModel: true,
  error: null,
  baseError: null,
  local: false,
  modelFile: null,
  nodes: [
    node("store", ["src/store/db.ts"]),
    node("api", ["src/api/routes.ts"], { parent: "app" }),
    node("app", [], { type: "container", group: true }),
    node("screen", ["src/screen/view.ts", "src/screen/list.ts"], {
      parent: "app",
    }),
    node("logs", []),
  ],
  edges: [
    {
      key: "screen>api",
      source: "screen",
      destination: "api",
      state: "same",
      description: "Calls",
    },
    {
      key: "api>store",
      source: "api",
      destination: "store",
      state: "same",
      description: "Reads",
    },
    {
      key: "store>logs",
      source: "store",
      destination: "logs",
      state: "same",
      description: "Writes",
    },
  ],
  hidden: 0,
  fileComponents: {
    "src/store/db.ts": "Store",
    "src/api/routes.ts": "Api",
    "src/screen/view.ts": "Screen",
    // The renamed file, known on the map by its old path only.
    "src/screen/old-list.ts": "Screen",
  },
  unmapped: ["src/other/loose.ts"],
  ambiguous: [{ file: "src/both.ts", ids: ["api", "store"] }],
  descriptions: { Store: "What store does" },
};

const FILES = [
  file("src/api/routes.ts"),
  file("src/store/db.ts"),
  file("src/screen/view.ts"),
  file("src/screen/list.ts", "src/screen/old-list.ts"),
  file("test/routes.test.ts"),
  file("README.md"),
  file("src/other/loose.ts"),
  file("src/both.ts"),
];

const entity = (name: string, state: EntityDiff["state"]): EntityDiff => ({
  name,
  state,
  file: null,
  component: null,
  fields: [],
  relationships: [],
  constraints: [],
});

const data = (entities: EntityDiff[]): DataResponse => ({
  status: "ok",
  readers: [],
  baseModel: true,
  entities,
  drafted: null,
});

const CHANGED_DATA = data([entity("Order", "changed"), entity("User", "same")]);

const step = (id: string, file: string, line: number): FlowStep => ({
  id,
  from: "A",
  to: "B",
  file,
  line,
  caller: "f",
  label: id,
  symbol: id,
  nesting: 0,
  verified: true,
});

/** One new flow through Api then Store. */
const FLOWS: FlowSet = {
  base: "a",
  head: "b",
  generatedAt: 0,
  flows: [
    {
      id: "save",
      name: "Save",
      trigger: "Tap save",
      isNew: true,
      participants: [],
      before: null,
      after: [
        step("s1", "src/api/routes.ts", 3),
        step("s2", "src/store/db.ts", 9),
        step("s3", "src/api/routes.ts", 7),
      ],
    },
  ],
  hunks: [],
  appFiles: [],
  costUsd: 0,
  durationMs: 0,
};

/** MAP's boxes as the map draws them: App with Screen above Api, then Store, then Logs. */
const DRAWN = ["app", "screen", "api", "store", "logs"];

const all = (extra: Partial<Parameters<typeof buildStops>[0]> = {}) =>
  buildStops({
    description: null,
    map: MAP,
    order: DRAWN,
    data: CHANGED_DATA,
    flows: null,
    files: FILES,
    ...extra,
  });

test("every changed file is in exactly one stop", () => {
  const stops = all();
  const paths = stops.flatMap((s) => s.files.map((f) => f.path));
  assert.equal(new Set(paths).size, paths.length, "a file is in two stops");
  assert.deepEqual([...paths].sort(), FILES.map((f) => f.path).sort());
  const screen = stops.find((s) => s.key === "component:screen");
  assert.deepEqual(
    screen?.files.map((f) => f.path),
    ["src/screen/view.ts", "src/screen/list.ts"],
  );
  assert.deepEqual(
    stops.find((s) => s.kind === "yourself")?.files.map((f) => f.path),
    ["test/routes.test.ts", "README.md", "src/other/loose.ts", "src/both.ts"],
  );
});

test("stops run overview, data, components in the map's order, yourself, finish", () => {
  assert.deepEqual(
    all().map((s) => s.key),
    [
      "overview",
      "data",
      "component:screen",
      "component:api",
      "component:store",
      "yourself",
      "finish",
    ],
  );
});

test("components follow the order the map reports, as it's drawn at any width", () => {
  const components = (order: string[] | null) =>
    all({ order })
      .filter((s) => s.kind === "component")
      .map((s) => s.key);
  assert.deepEqual(components(["store", "app", "api", "screen"]), [
    "component:store",
    "component:api",
    "component:screen",
  ]);
  // Before the map is drawn, and for a box it hasn't placed, the map's own
  // order stands.
  assert.deepEqual(components(null), [
    "component:store",
    "component:api",
    "component:screen",
  ]);
  assert.deepEqual(components(["screen"]), [
    "component:screen",
    "component:store",
    "component:api",
  ]);
});

test("a view that changes no data has no data stop", () => {
  for (const d of [data([entity("User", "same")]), null])
    assert.ok(!all({ data: d }).some((s) => s.kind === "data"));
  assert.deepEqual(all().find((s) => s.kind === "data")?.files, []);
});

test("with every file in a component, there's no stop for the rest", () => {
  const stops = all({ files: FILES.slice(0, 4) });
  assert.ok(!stops.some((s) => s.kind === "yourself"));
  assert.equal(stops.at(-1)?.kind, "finish");
});

test("with no map, the walk is the overview, every file, and the finish", () => {
  for (const map of [null, { ...MAP, status: "none" as const, nodes: [] }]) {
    const stops = all({ map, data: null });
    assert.deepEqual(
      stops.map((s) => s.kind),
      ["overview", "yourself", "finish"],
    );
    assert.equal(stops[1].files.length, FILES.length);
  }
});

test("uncommitted work's map, with nothing added or removed, gives a stop per changed component and the rest only for files no component has", () => {
  assert.ok(MAP.nodes.every((n) => ["touched", "neighbour"].includes(n.state)));
  assert.ok(MAP.edges.every((e) => e.state === "same"));
  const stops = all({ description: null, data: null });
  assert.deepEqual(
    stops.map((s) => s.key),
    [
      "overview",
      "component:screen",
      "component:api",
      "component:store",
      "yourself",
      "finish",
    ],
  );
  assert.deepEqual(
    stops.find((s) => s.kind === "yourself")?.files.map((f) => f.path),
    ["test/routes.test.ts", "README.md", "src/other/loose.ts", "src/both.ts"],
  );
});

test("a component's stop says the description's sentence on it, or else the map's", () => {
  const description: ChangeDescription = {
    what: "Saves orders.",
    why: null,
    lookFirst: [],
    components: [{ name: "Api", sentence: "Adds the save route." }],
  };
  const sentences = Object.fromEntries(
    all({ description }).flatMap((s) =>
      s.kind === "component" ? [[s.node.name, s.sentence]] : [],
    ),
  );
  assert.deepEqual(sentences, {
    Screen: "What screen does",
    Api: "Adds the save route.",
    Store: "What store does",
  });
});

test("a component's stop names its container and its arrows on the map", () => {
  const api = all().find((s) => s.key === "component:api");
  assert.equal(api?.kind === "component" && api.container, "App");
  assert.deepEqual(api?.kind === "component" && api.edges, [
    "screen>api",
    "api>store",
  ]);
  const store = all().find((s) => s.key === "component:store");
  assert.equal(store?.kind === "component" && store.container, null);
});

test("a component's stop lists the flow steps its files are on, and none untraced", () => {
  const chips = (flows: FlowSet | null) =>
    Object.fromEntries(
      all({ flows }).flatMap((s) =>
        s.kind === "component"
          ? [[s.node.name, s.steps.map((m) => m.chip)]]
          : [],
      ),
    );
  assert.deepEqual(chips(FLOWS), {
    Screen: [],
    Api: ["1·1", "1·3"],
    Store: ["1·2"],
  });
  assert.deepEqual(chips(null), { Screen: [], Api: [], Store: [] });
});

test("a component's stop lists the entities its steps write, each once, in flow and step order", () => {
  const tagged = (s: FlowStep, ...entities: string[]): FlowStep => ({
    ...s,
    data: entities.map((entity) => ({ entity, does: "sets it" })),
  });
  const flows: FlowSet = {
    ...FLOWS,
    flows: [
      {
        ...FLOWS.flows[0],
        after: [
          tagged(step("s1", "src/api/routes.ts", 3), "Basket"),
          step("s2", "src/store/db.ts", 9),
          tagged(step("s3", "src/api/routes.ts", 7), "Basket"),
        ],
      },
      {
        ...FLOWS.flows[0],
        id: "pay",
        after: [tagged(step("p1", "src/api/routes.ts", 12), "Order", "Basket")],
      },
    ],
  };
  const writes = Object.fromEntries(
    all({ flows }).flatMap((s) =>
      s.kind === "component" ? [[s.node.name, s.writes]] : [],
    ),
  );
  assert.deepEqual(writes, {
    Screen: [],
    Api: ["Basket", "Order"],
    Store: [],
  });
});

test("files not seen empties only once every stop with files is seen", () => {
  const stops = all();
  const seen = new Set<string>();
  assert.equal(filesNotSeen(stops, seen).length, FILES.length);

  const withFiles = stops.filter((s) => s.files.length > 0);
  for (const [i, stop] of stops.entries()) {
    seen.add(stop.key);
    const done = withFiles.every((s) => seen.has(s.key));
    assert.equal(
      filesNotSeen(stops, seen).length === 0,
      done,
      `after stop ${i + 1}`,
    );
  }
  assert.deepEqual(filesNotSeen(stops, seen), []);
});
