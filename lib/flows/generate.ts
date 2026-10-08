import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, gitLine, run } from "../exec";
import { isAppCode, readModelAt, type Model } from "../model";
import { claudeRunner, type Runner } from "./claude";
import { hunkText, mapNewToOld, parseZeroContext, type Hunk } from "./hunks";
import {
  basePrompt,
  baseSchema,
  headPrompt,
  headSchema,
  MAX_FLOWS,
  MAX_STEPS,
  tracePrompt,
  type BaseOutput,
  type HeadOutput,
  type RawFlow,
  type RawStep,
} from "./prompts";
import type { Flow, FlowParticipant, FlowSet, FlowStep } from "./types";

/**
 * Flows for one view: a base and a head (a commit and its parent, or a
 * branch's merge base and tip). The MVP recipe, the same for every view:
 *
 * 1. trace the flows at the head, from scratch;
 * 2. for each flow whose trigger existed before, trace its before side at the
 *    base, by handing Claude the head's steps to walk backwards. Steps whose
 *    line the diff didn't touch are carried by line mapping first, so
 *    "unchanged" is proven rather than Claude's opinion;
 * 3. verify every step's symbol on its line, on its side.
 *
 * At most two Claude runs; a new feature needs one. No view reads another
 * view's flows.
 */

/** git's empty tree, the base of a repository's first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GenerateOptions {
  root: string;
  base: string | null;
  head: string;
  runner?: Runner;
  onPhase?: (phase: string) => void;
}

interface Context {
  root: string;
  base: string | null;
  head: string;
  subject: string;
  model: Model | null;
  hunks: Hunk[];
  /** head path → base path, for renamed files */
  renames: Map<string, string>;
  appFiles: string[];
}

async function prepare(
  root: string,
  base: string | null,
  head: string,
): Promise<Context> {
  const subject =
    (await gitLine(root, ["log", "-1", "--format=%s", head])) ??
    head.slice(0, 7);
  const model = (await readModelAt(root, head))?.model ?? null;
  const { stdout } = await git(
    root,
    [
      "diff",
      "-U0",
      "-M",
      "--no-color",
      "--no-ext-diff",
      base ?? EMPTY_TREE,
      head,
    ],
    { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
  );
  const renames = new Map<string, string>();
  let from: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("rename from ")) from = line.slice(12);
    else if (line.startsWith("rename to ") && from)
      renames.set(line.slice(10), from);
  }
  const hunks = parseZeroContext(stdout)
    .filter((h) => isAppCode(model, h.file))
    .map((h, i) => ({ ...h, id: `H${i + 1}` }));
  const appFiles = [...new Set(hunks.map((h) => h.file))];
  return { root, base, head, subject, model, hunks, renames, appFiles };
}

/** The commit's files in a temp dir. Nothing in the repo is touched. */
async function snapshot(root: string, rev: string): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `backstory-flows-${rev.slice(0, 7)}-`),
  );
  try {
    // pipefail: a failed archive (a blobless clone, say) would otherwise
    // leave an empty folder, traced and cached as a change with no flows.
    await run(
      "bash",
      [
        "-o",
        "pipefail",
        "-c",
        'git archive "$1" | tar -x -C "$2"',
        "bash",
        rev,
        dir,
      ],
      {
        cwd: root,
        timeout: 120_000,
      },
    );
    return dir;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Runs `fn` over the commit's tracked files in a temp dir, deleted after: no
 * untracked or ignored files, no build output, no uncommitted work.
 */
export async function withSnapshot<T>(
  root: string,
  rev: string,
  fn: (dir: string) => Promise<T>,
) {
  const dir = await snapshot(root, rev);
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

type LineReader = (file: string, line: number) => Promise<string | null>;

/** Reads lines from a snapshot, a file at a time. */
function lineReader(dir: string): LineReader {
  const cache = new Map<string, string[] | null>();
  return async (file: string, line: number): Promise<string | null> => {
    if (!cache.has(file)) {
      const resolved = path.resolve(dir, file);
      // Claude names the file; it must stay inside the snapshot.
      const inside = resolved.startsWith(dir + path.sep);
      const text = inside
        ? await fs.readFile(resolved, "utf8").catch(() => null)
        : null;
      cache.set(file, text === null ? null : text.split("\n"));
    }
    return cache.get(file)?.[line - 1] ?? null;
  };
}

/** How far from the cited line a symbol may be found: Claude is often a line or two out. */
const NEAR = 3;
/** How many lines a call may run over, as a chained query does. */
const SPAN = 4;

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Does the symbol start on this line? On the line itself, or, ignoring
 * whitespace, running on over the next few lines.
 */
async function startsOn(
  read: LineReader,
  file: string,
  line: number,
  symbol: string,
) {
  const first = await read(file, line);
  if (first === null || symbol.length === 0) return false;
  if (first.includes(symbol)) return true;
  const want = squash(symbol);
  const head = squash(first);
  let joined = head;
  for (let k = 1; k < SPAN; k++)
    joined += squash((await read(file, line + k)) ?? "");
  const at = joined.indexOf(want);
  return at !== -1 && at < head.length;
}

/**
 * The line the symbol is really on: the cited one, or the nearest within a
 * few lines. Null when it isn't there, and the step stays unverified.
 */
export async function locate(
  read: LineReader,
  file: string,
  line: number,
  symbol: string,
  near = NEAR,
): Promise<number | null> {
  for (let d = 0; d <= near; d++) {
    for (const candidate of d === 0 ? [line] : [line - d, line + d]) {
      if (candidate >= 1 && (await startsOn(read, file, candidate, symbol)))
        return candidate;
    }
  }
  return null;
}

async function verifySteps(dir: string, steps: RawStep[]): Promise<FlowStep[]> {
  const read = lineReader(dir);
  const out: FlowStep[] = [];
  for (const s of steps) {
    const file = normalisePath(s.file);
    const found = await locate(read, file, s.line, s.symbol);
    out.push({ ...s, file, line: found ?? s.line, verified: found !== null });
  }
  return out;
}

const normalisePath = (file: string) =>
  file.replace(/^\.\//, "").replace(/^\/+/, "");

/** Ids Claude repeats across flows or steps are made unique, never merged. */
function dedupeIds(flows: RawFlow[]): RawFlow[] {
  const flowIds = new Set<string>();
  return flows.slice(0, MAX_FLOWS).map((f) => {
    let id = f.id || "flow";
    for (let n = 2; flowIds.has(id); n++) id = `${f.id}-${n}`;
    flowIds.add(id);
    const stepIds = new Set<string>();
    const steps = f.steps.slice(0, MAX_STEPS + 5).map((s) => {
      let sid = s.id || `${id}.step`;
      for (let n = 2; stepIds.has(sid); n++) sid = `${s.id}-${n}`;
      stepIds.add(sid);
      return { ...s, id: sid };
    });
    return { ...f, id, steps };
  });
}

function baseLineOf(ctx: Context, file: string, line: number) {
  const baseFile = ctx.renames.get(file) ?? file;
  const mapped = mapNewToOld(ctx.hunks, file, line);
  return mapped === null ? null : { file: baseFile, line: mapped };
}

/** Every participant, declared or only named by a step. Components are attached when shown. */
function participantsFor(
  _ctx: Context,
  raw: RawFlow["participants"][],
  steps: FlowStep[],
): FlowParticipant[] {
  const byName = new Map<string, FlowParticipant>();
  for (const list of raw) {
    for (const p of list)
      if (!byName.has(p.name)) byName.set(p.name, { ...p, component: null });
  }
  // A step can name a participant Claude forgot to declare.
  for (const s of steps) {
    for (const name of [s.from, s.to]) {
      if (!byName.has(name))
        byName.set(name, {
          name,
          label: name,
          external: false,
          component: null,
        });
    }
  }
  return [...byName.values()];
}

async function traceBefore(
  ctx: Context,
  runner: Runner,
  flows: { raw: RawFlow; after: FlowStep[] }[],
): Promise<{
  before: Map<string, { raw: RawFlow; steps: FlowStep[] }>;
  costUsd: number;
}> {
  const base = ctx.base!;
  return withSnapshot(ctx.root, base, async (dir) => {
    const read = lineReader(dir);
    const marked = [];
    for (const { raw, after } of flows) {
      const steps = [];
      for (const s of after) {
        const at = baseLineOf(ctx, s.file, s.line);
        // A carried step's line is proven by the mapping, so no searching nearby.
        const carried =
          at !== null && (await startsOn(read, at.file, at.line, s.symbol));
        const { verified: _verified, ...rest } = s;
        steps.push(
          carried
            ? { ...rest, file: at.file, line: at.line, status: "carried" }
            : { ...rest, status: "affected" },
        );
      }
      marked.push({ ...raw, steps });
    }
    const carried = new Map(
      marked.flatMap((f) =>
        f.steps.filter((s) => s.status === "carried").map((s) => [s.id, s]),
      ),
    );

    const { output, costUsd } = await runner<BaseOutput>(
      basePrompt({
        base: base.slice(0, 7),
        head: ctx.head.slice(0, 7),
        hunks: hunkText(ctx.hunks),
        flows: JSON.stringify(marked, null, 1),
      }),
      baseSchema(),
      dir,
    );

    const before = new Map<string, { raw: RawFlow; steps: FlowStep[] }>();
    for (const f of output.flows) {
      // A carried step's place is proven; only its meaning is Claude's.
      const steps = f.steps.map((s) => {
        const c = carried.get(s.id);
        return c ? { ...s, file: c.file, line: c.line, symbol: c.symbol } : s;
      });
      before.set(f.id, { raw: f, steps: await verifySteps(dir, steps) });
    }
    return { before, costUsd };
  });
}

export async function generateFlows(opts: GenerateOptions): Promise<FlowSet> {
  const started = Date.now();
  const runner = opts.runner ?? claudeRunner;
  const phase = opts.onPhase ?? (() => {});
  const ctx = await prepare(opts.root, opts.base, opts.head);

  const empty: FlowSet = {
    base: opts.base,
    head: opts.head,
    generatedAt: Date.now(),
    flows: [],
    hunks: [],
    appFiles: ctx.appFiles,
    costUsd: 0,
    durationMs: 0,
  };
  if (ctx.hunks.length === 0)
    return { ...empty, durationMs: Date.now() - started };

  phase("Tracing flows at the head");
  const head = await withSnapshot(ctx.root, ctx.head, async (dir) => {
    const { output, costUsd, model } = await runner<HeadOutput>(
      headPrompt({
        sha: ctx.head.slice(0, 7),
        subject: ctx.subject,
        hunks: hunkText(ctx.hunks),
        hasBase: ctx.base !== null,
      }),
      headSchema(),
      dir,
    );
    const flows = dedupeIds(output.flows);
    const verified = [];
    for (const raw of flows)
      verified.push({ raw, after: await verifySteps(dir, raw.steps) });
    return { flows: verified, hunks: output.hunks, costUsd, model };
  });

  let costUsd = head.costUsd;
  const existing = ctx.base ? head.flows.filter((f) => !f.raw.isNew) : [];
  let before = new Map<string, { raw: RawFlow; steps: FlowStep[] }>();
  if (existing.length > 0) {
    phase("Tracing the same flows at the base");
    const result = await traceBefore(ctx, runner, existing);
    before = result.before;
    costUsd += result.costUsd;
  }

  const flows: Flow[] = head.flows.map(({ raw, after }) => {
    const isNew = ctx.base === null || raw.isNew;
    const prior = isNew ? undefined : before.get(raw.id);
    const steps = [...after, ...(prior?.steps ?? [])];
    return {
      id: raw.id,
      name: raw.name,
      trigger: raw.trigger,
      isNew,
      participants: participantsFor(
        ctx,
        [raw.participants, prior?.raw.participants ?? []],
        steps,
      ),
      before: isNew ? null : (prior?.steps ?? []),
      after,
    };
  });

  const assigned = new Map(head.hunks.map((h) => [h.id, h]));
  return {
    ...empty,
    generatedAt: Date.now(),
    flows,
    hunks: ctx.hunks.map((h) => ({
      id: h.id,
      file: h.file,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      flows: (assigned.get(h.id)?.flows ?? []).filter((id) =>
        flows.some((f) => f.id === id),
      ),
      ...(assigned.get(h.id)?.reason
        ? { reason: assigned.get(h.id)?.reason }
        : {}),
    })),
    costUsd,
    durationMs: Date.now() - started,
    model: head.model,
  };
}

/**
 * One more flow, for a hunk the first pass left on none. Added to the set;
 * the hunk is marked as on it.
 */
export async function traceHunk(
  opts: GenerateOptions & { set: FlowSet; hunkId: string },
): Promise<FlowSet> {
  const started = Date.now();
  const runner = opts.runner ?? claudeRunner;
  const ctx = await prepare(opts.root, opts.base, opts.head);
  // Ids are positions among the app-code hunks, and which hunks are app
  // code follows the model, which may have changed since the set was
  // traced: find the cached hunk again by where it is, not by its id.
  const cached = opts.set.hunks.find((h) => h.id === opts.hunkId);
  const hunk =
    cached &&
    ctx.hunks.find(
      (h) =>
        h.file === cached.file &&
        h.oldStart === cached.oldStart &&
        h.oldLines === cached.oldLines &&
        h.newStart === cached.newStart &&
        h.newLines === cached.newLines,
    );
  if (!hunk) throw new Error(`No hunk ${opts.hunkId} in this change.`);

  const head = await withSnapshot(ctx.root, ctx.head, async (dir) => {
    const { output, costUsd } = await runner<HeadOutput>(
      tracePrompt({
        sha: ctx.head.slice(0, 7),
        subject: ctx.subject,
        hunk: hunkText([hunk]),
        known: opts.set.flows.map((f) => `"${f.name}"`).join(", "),
      }),
      headSchema(1),
      dir,
    );
    const taken = new Set(opts.set.flows.map((f) => f.id));
    const flows = dedupeIds(output.flows).map((f) => {
      let id = f.id;
      for (let n = 2; taken.has(id); n++) id = `${f.id}-${n}`;
      return { ...f, id };
    });
    const verified = [];
    for (const raw of flows)
      verified.push({ raw, after: await verifySteps(dir, raw.steps) });
    return { flows: verified, costUsd };
  });

  const found = head.flows[0];
  if (!found) return opts.set;
  let costUsd = head.costUsd;
  let prior: { raw: RawFlow; steps: FlowStep[] } | undefined;
  const isNew = ctx.base === null || found.raw.isNew;
  if (!isNew) {
    const result = await traceBefore(ctx, runner, [found]);
    prior = result.before.get(found.raw.id);
    costUsd += result.costUsd;
  }
  const steps = [...found.after, ...(prior?.steps ?? [])];
  const flow: Flow = {
    id: found.raw.id,
    name: found.raw.name,
    trigger: found.raw.trigger,
    isNew,
    participants: participantsFor(
      ctx,
      [found.raw.participants, prior?.raw.participants ?? []],
      steps,
    ),
    before: isNew ? null : (prior?.steps ?? []),
    after: found.after,
  };
  return {
    ...opts.set,
    flows: [...opts.set.flows, flow],
    hunks: opts.set.hunks.map((h) =>
      h.id === opts.hunkId ? { ...h, flows: [...h.flows, flow.id] } : h,
    ),
    costUsd: opts.set.costUsd + costUsd,
    durationMs: opts.set.durationMs + (Date.now() - started),
  };
}
