/**
 * What Claude is asked, and the shape it answers in. Ported from the prompt
 * test in differ's local/prototypes/flows/gen.py; the "before" prompt is that
 * script's edit prompt run backwards, from the head to the base.
 *
 * Claude returns compact steps; differ verifies them and wraps them in SARIF.
 */

export const MAX_FLOWS = 5;
export const MAX_STEPS = 15;

const STEP_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    file: { type: "string" },
    line: { type: "integer" },
    caller: { type: "string" },
    label: { type: "string" },
    symbol: { type: "string" },
    returns: { type: "string" },
    repeat: { type: "string" },
    sameAs: { type: "string" },
    nesting: { type: "integer" },
  },
  required: ["id", "from", "to", "file", "line", "caller", "label", "symbol", "nesting"],
};

const flowSchema = (maxSteps: number) => ({
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    trigger: { type: "string" },
    isNew: { type: "boolean" },
    participants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          label: { type: "string" },
          external: { type: "boolean" },
        },
        required: ["name", "label", "external"],
      },
    },
    steps: { type: "array", maxItems: maxSteps, items: STEP_SCHEMA },
  },
  required: ["id", "name", "trigger", "isNew", "participants", "steps"],
});

const HUNKS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      flows: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
    required: ["id", "flows"],
  },
};

export const headSchema = (maxFlows = MAX_FLOWS) => ({
  type: "object",
  properties: {
    flows: { type: "array", maxItems: maxFlows, items: flowSchema(MAX_STEPS) },
    hunks: HUNKS_SCHEMA,
  },
  required: ["flows", "hunks"],
});

/** Before sides can run a little longer: they hold the code the change removed. */
export const baseSchema = () => ({
  type: "object",
  properties: {
    flows: { type: "array", items: flowSchema(MAX_STEPS + 5) },
  },
  required: ["flows"],
});

export interface RawStep {
  id: string;
  from: string;
  to: string;
  file: string;
  line: number;
  caller: string;
  label: string;
  symbol: string;
  returns?: string;
  repeat?: string;
  sameAs?: string;
  nesting: number;
}

export interface RawFlow {
  id: string;
  name: string;
  trigger: string;
  isNew: boolean;
  participants: { name: string; label: string; external: boolean }[];
  steps: RawStep[];
}

export interface HeadOutput {
  flows: RawFlow[];
  hunks: { id: string; flows: string[]; reason?: string }[];
}

export interface BaseOutput {
  flows: RawFlow[];
}

const STEP_RULES = `For each step give:
- file and line: the call site, the line where the call happens, in this commit. Read the file to get it exactly. Paths are relative to the repository root.
- symbol: an exact substring of that line that names the call, e.g. "repository.points(for: movement". It is checked mechanically, so copy it character for character.
- caller: the function containing the call, e.g. "MovementProgressViewModel.reload()".
- from, to: participant type names. Framework types are participants too (e.g. NSManagedObjectContext, ActiveRecord::Base, fetch); mark them external.
- label: the call as a reader would say it, in code terms and short, e.g. "contextsWithData(for: movement)".
- returns: what comes back, in a few words, only if it matters to the flow.
- repeat: if the call runs more than once per trigger, how often, e.g. "for each of 2 contexts".
- sameAs: if this step re-runs an earlier step's whole subtree, that step's id, instead of listing its steps again.
- nesting: call depth from the trigger; 0 for the entry call.
- id: "<flow id>.<short-kebab-name>", descriptive.

Describe only what the code does. Don't judge it, and don't add a step you can't point to on a line.`;

export function headPrompt(opts: {
  sha: string;
  subject: string;
  hunks: string;
  hasBase: boolean;
}): string {
  return `You are tracing flows through a code change, for a reviewer. A flow is what the code does when one trigger happens: a user action (open a screen, tap a button, submit a form, call an endpoint) or a system event (app launch, background job, sync). Each flow is a sequence of calls between types.

The repository at commit ${opts.sha} ("${opts.subject}") is in the current directory. Read files with Read, Grep and Glob. Don't modify anything.

The change${opts.hasBase ? "" : " (the repository's first commit)"} touched these hunks of app code:

${opts.hunks}

1. Choose the flows that reach the changed code. Every hunk should sit on at least one flow's steps, unless it changes no behaviour (copy, colours, layout constants, comments, declarations only); then list it with no flows and say why. At most ${MAX_FLOWS} flows. One flow per trigger, named by the trigger, e.g. "Open progress from Exercise". Flow ids are short kebab-case, e.g. "open-from-exercise".
2. For each flow, list its steps in execution order, at most ${MAX_STEPS}. A step is one call from one participant (a type) to another, or to itself when the self-call matters. Start at the trigger's entry point. Include unchanged code only where it connects the trigger to changed code, or where the changed code's results go. Skip trivial getters, logging, and view modifiers that don't change behaviour.
3. isNew: true if the trigger didn't exist before this change (a new feature); false if it existed and the change altered what happens.
4. For each hunk, list the ids of the flows whose steps sit in it.

${STEP_RULES}`;
}

export function basePrompt(opts: {
  base: string;
  head: string;
  hunks: string;
  flows: string;
}): string {
  return `You are tracing flows through a codebase, for a reviewer comparing the code before and after a change. A flow is what the code does when one trigger happens, as a sequence of calls between types. The flows below were traced at the head commit ${opts.head}. Your job is to write each of them as it ran at the base commit ${opts.base}, before the change.

The repository at the base commit ${opts.base} is in the current directory. Read files with Read, Grep and Glob. Don't modify anything.

The change, from base (old) to head (new):

${opts.hunks}

The flows at the head, with each step marked:
- "carried": the change didn't touch its line; it has already been moved to its line at the base and checked there. Keep its id, file, line and symbol. But the code around it may have done something different at the base (a different query, a different loop): re-read it, and update its label, returns and repeat if they weren't true then.
- "affected": the change added or edited its line. If the same call existed at the base, keep the step's id with its base file, line and symbol. If it didn't exist, leave it out.

${opts.flows}

Return every flow above, with the same id, name and trigger, and its full step list at the base, in execution order:
- Keep the ids of steps that are the same call.
- Add steps for code the trigger reached at the base that the change removed or replaced, with new ids.
- Leave out steps for calls that didn't exist at the base.
- Line numbers, files and symbols are the base's.

${STEP_RULES}`;
}

export function tracePrompt(opts: {
  sha: string;
  subject: string;
  hunk: string;
  known: string;
}): string {
  return `You are tracing one flow through a code change, for a reviewer. A flow is what the code does when one trigger happens: a user action or a system event. It is a sequence of calls between types.

The repository at commit ${opts.sha} ("${opts.subject}") is in the current directory. Read files with Read, Grep and Glob. Don't modify anything.

The reviewer asked for a flow that reaches this hunk:

${opts.hunk}

Flows already traced for this change (don't repeat them): ${opts.known || "none"}.

Return exactly one flow: name the trigger that reaches this hunk, and list the steps from the trigger's entry point through the changed code, at most ${MAX_STEPS}. isNew: true if the trigger didn't exist before this change. List the hunk with the flow's id.

${STEP_RULES}`;
}
