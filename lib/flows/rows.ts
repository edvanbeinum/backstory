import { isAddedLine } from "./hunks";
import type { Flow, FlowHunk, FlowStep } from "./types";

/**
 * A flow as rows to draw, diffed like lines: a step is kept, added or
 * removed, with its number before ("was") and after ("now").
 */

export type FlowMode = "diff" | "before" | "after";
export type RowKind = "ctx" | "add" | "del";

export interface FlowRow {
  key: string;
  kind: RowKind;
  was: number | null;
  now: number | null;
  step: FlowStep;
  /** Which side of the diff the step's line is on */
  side: "old" | "new";
  /** "runs 2–7 again", from `sameAs` */
  again: string | null;
}

/** Longest common subsequence of step ids: which steps both sides share. */
function commonIds(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      out.add(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** The note a `sameAs` step carries: the range of steps it re-runs. */
function againNote(steps: FlowStep[], step: FlowStep): string | null {
  if (!step.sameAs) return null;
  const start = steps.findIndex((s) => s.id === step.sameAs);
  if (start === -1) return null;
  let end = start;
  while (
    end + 1 < steps.length &&
    steps[end + 1].nesting > steps[start].nesting
  )
    end++;
  return end > start
    ? `runs ${start + 1}–${end + 1} again`
    : `runs ${start + 1} again`;
}

const sameWords = (a: FlowStep, b: FlowStep) =>
  a.label === b.label &&
  (a.returns ?? "") === (b.returns ?? "") &&
  (a.repeat ?? "") === (b.repeat ?? "");

export function flowRows(
  flow: Flow,
  mode: FlowMode,
  hunks: FlowHunk[],
): FlowRow[] {
  const after = flow.after;
  const before = flow.before ?? [];
  const row = (
    kind: RowKind,
    step: FlowStep,
    side: "old" | "new",
    was: number | null,
    now: number | null,
    list: FlowStep[],
  ): FlowRow => ({
    key: `${kind}:${side}:${step.id}`,
    kind,
    was,
    now,
    step,
    side,
    again: againNote(list, step),
  });

  if (mode === "after")
    return after.map((s, i) => row("ctx", s, "new", null, i + 1, after));
  if (mode === "before")
    return before.map((s, i) => row("ctx", s, "old", i + 1, null, before));

  // A new flow: "+" only for steps on lines the change added. A step on
  // code that was already there is context the new trigger now reaches.
  if (flow.before === null) {
    return after.map((s, i) =>
      row(
        isAddedLine(hunks, s.file, s.line) ? "add" : "ctx",
        s,
        "new",
        null,
        i + 1,
        after,
      ),
    );
  }

  const shared = commonIds(
    before.map((s) => s.id),
    after.map((s) => s.id),
  );
  const rows: FlowRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const b = before[i];
    const a = after[j];
    if (b && !shared.has(b.id)) {
      rows.push(row("del", b, "old", i + 1, null, before));
      i++;
    } else if (a && !shared.has(a.id)) {
      // Newly on the flow but on unchanged code: a step without a "was"
      // number, not a "+".
      const kind = isAddedLine(hunks, a.file, a.line) ? "add" : "ctx";
      rows.push(row(kind, a, "new", null, j + 1, after));
      j++;
    } else if (a && b) {
      if (sameWords(a, b)) {
        rows.push(row("ctx", a, "new", i + 1, j + 1, after));
      } else {
        // The same call doing something different reads as a changed line:
        // the old wording out, the new one in.
        rows.push(row("del", b, "old", i + 1, null, before));
        rows.push(row("add", a, "new", null, j + 1, after));
      }
      i++;
      j++;
    } else {
      break;
    }
  }
  return rows;
}

export interface FlowSummary {
  added: number;
  removed: number;
  beforeSteps: number | null;
  afterSteps: number;
  /** The change altered this flow (or it's new) */
  changed: boolean;
}

export function summarise(flow: Flow, hunks: FlowHunk[]): FlowSummary {
  const rows = flowRows(flow, "diff", hunks);
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  return {
    added,
    removed,
    beforeSteps: flow.before?.length ?? null,
    afterSteps: flow.after.length,
    changed: flow.isNew || added > 0 || removed > 0,
  };
}

/** Participants in lane order, keeping only the ones these rows use. */
export function lanesFor(flow: Flow, rows: FlowRow[]): Flow["participants"] {
  const used = new Set(rows.flatMap((r) => [r.step.from, r.step.to]));
  const known = flow.participants.filter((p) => used.has(p.name));
  const extra = [...used]
    .filter((n) => !known.some((p) => p.name === n))
    .map((name) => ({ name, label: name, external: false }));
  return [...known, ...extra];
}

const words = (name: string) =>
  name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [name];

/**
 * Short lane names, as the approved mockup draws them: a CamelCase prefix
 * two participants share is dropped ("MovementProgressViewModel" beside
 * "MovementProgressView" reads "ViewModel" and "View"), unless that leaves two lanes
 * with one name. The full name stays in the chip's title.
 */
export function shortLabels(
  lanes: { name: string; label: string }[],
): Map<string, string> {
  const split = lanes.map((l) => words(l.label));
  const short = split.map((w, i) => {
    let best = 0;
    for (let j = 0; j < split.length; j++) {
      if (j === i) continue;
      let k = 0;
      // A prefix must leave both names a word: "View" beside "ViewModel" keeps
      // "View", not "".
      while (
        k < w.length - 1 &&
        k < split[j].length - 1 &&
        w[k] === split[j][k]
      )
        k++;
      best = Math.max(best, k);
    }
    return w.slice(best).join("");
  });
  const seen = new Map<string, number>();
  for (const label of short) seen.set(label, (seen.get(label) ?? 0) + 1);
  return new Map(
    lanes.map((l, i) => [
      l.name,
      (seen.get(short[i]) ?? 0) > 1 ? l.label : short[i],
    ]),
  );
}

export interface LaneGroup {
  /** The component's name; null for framework types and for code the model doesn't place */
  component: string | null;
  external: boolean;
  /** Lane indexes, inclusive */
  start: number;
  end: number;
}

const groupKey = (p: Flow["participants"][number]) =>
  p.external ? "\u0000external" : (p.component ?? "\u0000unplaced");

/**
 * Lanes ordered so each component's types sit side by side, components in
 * the order the flow first reaches them, framework types at the far edge.
 * A call that crosses a group's edge is one component calling another.
 */
export function groupLanes(
  flow: Flow,
  rows: FlowRow[],
): { lanes: Flow["participants"]; groups: LaneGroup[] } {
  const lanes = lanesFor(flow, rows);
  const firstSeen = new Map<string, number>();
  rows.forEach((r, i) => {
    for (const name of [r.step.from, r.step.to])
      if (!firstSeen.has(name)) firstSeen.set(name, i);
  });
  const order = new Map<string, number>();
  for (const p of [...lanes].sort(
    (a, b) => (firstSeen.get(a.name) ?? 0) - (firstSeen.get(b.name) ?? 0),
  )) {
    const key = groupKey(p);
    if (!order.has(key)) order.set(key, order.size);
  }
  const rank = (p: Flow["participants"][number]) =>
    p.external ? Number.MAX_SAFE_INTEGER : (order.get(groupKey(p)) ?? 0);
  const sorted = lanes
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);

  const groups: LaneGroup[] = [];
  sorted.forEach((p, i) => {
    const last = groups[groups.length - 1];
    if (last && groupKey(sorted[last.start]) === groupKey(p)) last.end = i;
    else
      groups.push({
        component: p.external ? null : (p.component ?? null),
        external: p.external,
        start: i,
        end: i,
      });
  });
  return { lanes: sorted, groups };
}

/** The components a flow passes through, in the order it first reaches them. */
export function componentPath(flow: Flow, rows: FlowRow[]): string[] {
  const byName = new Map(flow.participants.map((p) => [p.name, p]));
  const path: string[] = [];
  for (const r of rows) {
    for (const name of [r.step.from, r.step.to]) {
      const c = byName.get(name);
      if (c && !c.external && c.component && !path.includes(c.component))
        path.push(c.component);
    }
  }
  return path;
}
