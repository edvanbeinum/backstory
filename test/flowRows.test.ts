import assert from "node:assert/strict";
import { test } from "node:test";

import { flowRows, shortLabels, summarise } from "../lib/flows/rows";
import type { Flow, FlowHunk, FlowStep } from "../lib/flows/types";

const step = (id: string, line: number, extra: Partial<FlowStep> = {}): FlowStep => ({
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
  { id: "H1", file: "a.ts", oldStart: 3, oldLines: 2, newStart: 3, newLines: 1, flows: [] },
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
  flowRows(f, "diff", hunks).map((r) => `${r.kind} ${r.was ?? "-"} ${r.now ?? "-"} ${r.step.id}`);

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
  const f = flow([step("load", 1, { label: "fetch one" })], [step("load", 1, { label: "fetch all" })]);
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
    ["MovementProgressView", "MovementProgressViewModel", "MovementProgressRepository", "NSManagedObjectContext", "ExerciseView"].map(lane),
  );
  assert.deepEqual([...labels.values()], [
    "View",
    "ViewModel",
    "Repository",
    "NSManagedObjectContext",
    "ExerciseView",
  ]);
});

test("a short name that two lanes would share stays long", () => {
  const lane = (name: string) => ({ name, label: name });
  const labels = shortLabels(["HistoryView", "HistoryModel", "ExerciseView", "ExerciseModel"].map(lane));
  assert.deepEqual([...labels.values()], ["HistoryView", "HistoryModel", "ExerciseView", "ExerciseModel"]);
});
