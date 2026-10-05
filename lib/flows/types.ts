/**
 * Flows: what the code does for one trigger (a user action or a system
 * event), as a sequence of calls between types, traced by Claude Code at the
 * view's base and head. Shared by the server, which builds them, and the
 * window, which draws them.
 */

export interface FlowParticipant {
  /** The type's name, as steps' `from` and `to` refer to it */
  name: string;
  label: string;
  /** A framework or library type, not the repo's own */
  external: boolean;
  /** The C4 component its code lives in, when the repo has a model */
  component?: string | null;
}

export interface FlowStep {
  /** Stable within a view: a step keeps its id from base to head */
  id: string;
  from: string;
  to: string;
  /** The call site, at the side's commit */
  file: string;
  line: number;
  /** The function containing the call */
  caller: string;
  label: string;
  /** Text that must appear on `line`; checked, not trusted */
  symbol: string;
  returns?: string;
  repeat?: string;
  /** This step re-runs an earlier step's subtree */
  sameAs?: string;
  nesting: number;
  verified: boolean;
}

export interface Flow {
  id: string;
  name: string;
  trigger: string;
  /** The trigger didn't exist at the base, so there is no before side */
  isNew: boolean;
  participants: FlowParticipant[];
  /** Null for a new flow */
  before: FlowStep[] | null;
  after: FlowStep[];
}

/** One changed region of app code, from a zero-context diff. */
export interface FlowHunk {
  id: string;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Ids of the flows whose steps reach it; empty when it's on none */
  flows: string[];
  reason?: string;
}

export interface FlowSet {
  /** Null when the head has no parent: everything is new */
  base: string | null;
  head: string;
  generatedAt: number;
  flows: Flow[];
  hunks: FlowHunk[];
  /** Files counted as app code: not tests, not ignored */
  appFiles: string[];
  costUsd: number;
  durationMs: number;
  /** The model that traced them, e.g. claude-opus-5-5 */
  model?: string | null;
}

export type FlowsStatus =
  | { status: "ready"; flows: FlowSet; tracing: string[]; runError?: string }
  | { status: "running"; startedAt: number; phase: string }
  | { status: "idle" }
  | { status: "failed"; error: string }
  | { status: "unavailable"; reason: "uncommitted" | "no-claude" };
