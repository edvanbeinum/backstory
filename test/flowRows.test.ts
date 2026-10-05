import assert from "node:assert/strict";
import { test } from "node:test";

import {
  componentPath,
  flowRows,
  groupParticipants,
  shortLabels,
  summarise,
} from "../lib/flows/rows";
import type { Flow, FlowHunk, FlowStep } from "../lib/flows/types";

const step = (
  id: string,
  line: number,
  extra: Partial<FlowStep> = {},
): FlowStep => ({
  id,
  from: "A",
  to: "B",
  file: "a.ts",
  line,
  caller: "A.run",
  label: id,
  symbol: id,
  nesting: 0,
  verified: true,
  ...extra,
});

const hunks: FlowHunk[] = [
  {
    id: "H1",
    file: "a.ts",
    oldStart: 3,
    oldLines: 2,
    newStart: 3,
    newLines: 1,
    flows: [],
  },
];

const flow = (before: FlowStep[] | null, after: FlowStep[]): Flow => ({
  id: "f",
  name: "F",
  trigger: "t",
  isNew: before === null,
  participants: [],
  before,
  after,
});

const shape = (f: Flow) =>
  flowRows(f, "diff", hunks).map(
    (r) => `${r.kind} ${r.was ?? "-"} ${r.now ?? "-"} ${r.step.id}`,
  );

test("a changed flow reads like a line diff", () => {
  const f = flow(
    [step("init", 1), step("fetch1", 3), step("fetch2", 4), step("render", 5)],
    [step("init", 1), step("fetchOnce", 3), step("render", 4)],
  );
  assert.deepEqual(shape(f), [
    "ctx 1 1 init",
    "del 2 - fetch1",
    "del 3 - fetch2",
    "add - 2 fetchOnce",
    "ctx 4 3 render",
  ]);
  assert.deepEqual(summarise(f, hunks), {
    added: 1,
    removed: 2,
    beforeSteps: 4,
    afterSteps: 3,
    changed: true,
  });
});

test("the same call with new words is a removal and an addition", () => {
  const f = flow(
    [step("load", 1, { label: "fetch one" })],
    [step("load", 1, { label: "fetch all" })],
  );
  assert.deepEqual(shape(f), ["del 1 - load", "add - 1 load"]);
});

test("a step newly on the flow, on unchanged code, is not a +", () => {
  const f = flow([step("init", 1)], [step("init", 1), step("helper", 9)]);
  assert.deepEqual(shape(f), ["ctx 1 1 init", "ctx - 2 helper"]);
  assert.equal(summarise(f, hunks).changed, false);
});

test("a new flow marks only steps on added lines", () => {
  const f = flow(null, [step("init", 1), step("fresh", 3)]);
  assert.deepEqual(shape(f), ["ctx - 1 init", "add - 2 fresh"]);
});

test("sameAs reads as the range of steps it re-runs", () => {
  const steps = [
    step("open", 1),
    step("load", 2, { nesting: 1 }),
    step("fetch", 3, { nesting: 2 }),
    step("parse", 4, { nesting: 2 }),
    step("appear", 5),
    step("reload", 6, { nesting: 1, sameAs: "load" }),
  ];
  const rows = flowRows(flow(null, steps), "after", hunks);
  assert.equal(rows[5].again, "runs 2–4 again");
});

test("lanes drop a shared prefix unless that makes two lanes one name", () => {
  const lane = (name: string) => ({ name, label: name });
  const labels = shortLabels(
    [
      "MovementProgressView",
      "MovementProgressViewModel",
      "MovementProgressRepository",
      "NSManagedObjectContext",
      "ExerciseView",
    ].map(lane),
  );
  assert.deepEqual(
    [...labels.values()],
    [
      "View",
      "ViewModel",
      "Repository",
      "NSManagedObjectContext",
      "ExerciseView",
    ],
  );
});

test("a short name that two lanes would share stays long", () => {
  const lane = (name: string) => ({ name, label: name });
  const labels = shortLabels(
    ["HistoryView", "HistoryModel", "ExerciseView", "ExerciseModel"].map(lane),
  );
  assert.deepEqual(
    [...labels.values()],
    ["HistoryView", "HistoryModel", "ExerciseView", "ExerciseModel"],
  );
});

test("coverage counts the diff's own hunks, on a flow or not", async () => {
  const { coverage } = await import("../lib/flows/coverage");
  const set = {
    base: "b",
    head: "h",
    generatedAt: 0,
    flows: [],
    hunks: [
      {
        id: "H1",
        file: "a.ts",
        oldStart: 3,
        oldLines: 1,
        newStart: 3,
        newLines: 1,
        flows: ["f"],
      },
      {
        id: "H2",
        file: "a.ts",
        oldStart: 40,
        oldLines: 0,
        newStart: 41,
        newLines: 1,
        flows: [],
        reason: "a comment",
      },
    ],
    appFiles: ["a.ts"],
    costUsd: 0,
    durationMs: 0,
  };
  const line = (
    type: "add" | "del" | "context",
    oldNo: number | null,
    newNo: number | null,
  ) => ({
    type,
    oldNo,
    newNo,
    content: "",
  });
  const files = [
    {
      oldPath: "a.ts",
      newPath: "a.ts",
      path: "a.ts",
      status: "modified" as const,
      isBinary: false,
      additions: 2,
      deletions: 1,
      lang: null,
      hunks: [
        {
          header: "",
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          lines: [
            line("context", 2, 2),
            line("del", 3, null),
            line("add", null, 3),
            line("context", 4, 4),
          ],
        },
        {
          header: "",
          oldStart: 38,
          oldLines: 4,
          newStart: 39,
          newLines: 5,
          lines: [
            line("context", 40, 40),
            line("add", null, 41),
            line("context", 41, 42),
          ],
        },
      ],
    },
    {
      ...{ oldPath: "t.test.ts", newPath: "t.test.ts", path: "t.test.ts" },
      status: "added" as const,
      isBinary: false,
      additions: 1,
      deletions: 0,
      lang: null,
      hunks: [],
    },
  ];
  const result = coverage(set, files);
  assert.deepEqual(
    result.map((h) => [h.line, h.onFlow, h.offFlow.map((z) => z.id)]),
    [
      [3, true, []],
      [41, false, ["H2"]],
    ],
  );
});

test("participants group by component, in the order the flow reaches them", () => {
  const call = (id: string, from: string, to: string) =>
    step(id, 1, { from, to });
  const f: Flow = {
    ...flow(null, [
      call("route", "Router", "Controller"),
      call("scope", "Controller", "Scope"),
      call("load", "Controller", "Library"),
      call("rows", "Library", "Listing"),
    ]),
    participants: [
      { name: "Router", label: "Router", external: true },
      {
        name: "Controller",
        label: "Controller",
        external: false,
        component: "Native API",
      },
      { name: "Scope", label: "Scope", external: false, component: "Access" },
      {
        name: "Library",
        label: "Library",
        external: false,
        component: "Native API",
      },
      {
        name: "Listing",
        label: "Listing",
        external: false,
        component: "Catalog",
      },
    ],
  };
  const rows = flowRows(f, "after", hunks);
  const { participants, groups } = groupParticipants(f, rows);
  assert.deepEqual(
    participants.map((p) => p.name),
    ["Controller", "Library", "Scope", "Listing", "Router"],
  );
  assert.deepEqual(
    groups.map((g) => [g.component, g.start, g.end]),
    [
      ["Native API", 0, 1],
      ["Access", 2, 2],
      ["Catalog", 3, 3],
      [null, 4, 4],
    ],
  );
  assert.deepEqual(componentPath(f, rows), ["Native API", "Access", "Catalog"]);
});
