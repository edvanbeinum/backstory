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
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
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
  while (end + 1 < steps.length && steps[end + 1].nesting > steps[start].nesting) end++;
  return end > start ? `runs ${start + 1}–${end + 1} again` : `runs ${start + 1} again`;
}

const sameWords = (a: FlowStep, b: FlowStep) =>
  a.label === b.label && (a.returns ?? "") === (b.returns ?? "") && (a.repeat ?? "") === (b.repeat ?? "");

export function flowRows(flow: Flow, mode: FlowMode, hunks: FlowHunk[]): FlowRow[] {
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

  if (mode === "after") return after.map((s, i) => row("ctx", s, "new", null, i + 1, after));
  if (mode === "before") return before.map((s, i) => row("ctx", s, "old", i + 1, null, before));

  // A new flow: "+" only for steps on lines the change added. A step on
  // code that was already there is context the new trigger now reaches.
  if (flow.before === null) {
    return after.map((s, i) =>
      row(isAddedLine(hunks, s.file, s.line) ? "add" : "ctx", s, "new", null, i + 1, after),
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

const words = (name: string) => name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [name];

/**
 * Short lane names, as the approved mockup draws them: a CamelCase prefix
 * two participants share is dropped ("MovementProgressViewModel" beside
 * "MovementProgressView" reads "ViewModel" and "View"), unless that leaves two lanes
 * with one name. The full name stays in the chip's title.
 */
export function shortLabels(lanes: { name: string; label: string }[]): Map<string, string> {
  const split = lanes.map((l) => words(l.label));
  const short = split.map((w, i) => {
    let best = 0;
    for (let j = 0; j < split.length; j++) {
      if (j === i) continue;
      let k = 0;
      // A prefix must leave both names a word: "View" beside "ViewModel" keeps
      // "View", not "".
      while (k < w.length - 1 && k < split[j].length - 1 && w[k] === split[j][k]) k++;
      best = Math.max(best, k);
    }
    return w.slice(best).join("");
  });
  const seen = new Map<string, number>();
  for (const label of short) seen.set(label, (seen.get(label) ?? 0) + 1);
  return new Map(
    lanes.map((l, i) => [l.name, (seen.get(short[i]) ?? 0) > 1 ? l.label : short[i]]),
  );
}
