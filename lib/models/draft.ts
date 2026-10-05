import { promises as fs } from "node:fs";
import path from "node:path";

import { git, gitLine } from "../exec";
import {
  claudeAvailable,
  claudeRunner,
  flowsModel,
  type Runner,
} from "../flows/claude";
import { withSnapshot } from "../flows/generate";
import { localModelDir, MODEL_DSL, showFile } from "../model";
import { assignIds, serializeModel, type DraftIds } from "./dsl";
import { checkGlobs, type GlobCheck } from "./globs";
import {
  draftPrompt,
  draftSchema,
  globFixPrompt,
  globFixSchema,
  type DraftOutput,
  type GlobFixOutput,
} from "./prompts";

/**
 * Drafting a C4 model for a repo that has none: Claude reads the code at
 * HEAD and differ writes the result to the local model file the map already
 * reads, `~/.differ/models/<repo>/workspace.dsl`. Never into the repo.
 *
 * One job per repo, in memory on globalThis, as `lib/flows/cache.ts` keeps
 * its runs: Next may load this module once per route bundle. A restart
 * mid-draft loses the job and writes nothing.
 */

/** Paths the glob fix-up is shown, so a draft that missed most files stays one bounded call. */
const MAX_FIX_PATHS = 200;
/** Paths the file's header names before the rest become "and N more". */
const MAX_HEADER_PATHS = 50;

export type DraftStatus =
  | { status: "idle" }
  | { status: "running"; phase: string; startedAt: number }
  | {
      status: "done";
      costUsd: number;
      model: string | null;
      durationMs: number;
      unmatched: number;
      ambiguous: number;
    }
  | { status: "failed"; error: string }
  | { status: "unavailable"; reason: "no-claude" };

/** Why a draft didn't start: the repo commits a model, or a local one needs `redraft`. */
export interface DraftRefusal {
  status: "refused";
  reason: "committed" | "exists";
}

export interface DraftResult {
  dsl: string;
  costUsd: number;
  model: string | null;
  durationMs: number;
  unmatched: number;
  ambiguous: number;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function applyFix(
  output: DraftOutput,
  ids: DraftIds,
  fix: GlobFixOutput,
): DraftOutput {
  const revised = new Map(fix.components.map((c) => [c.id, c.globs]));
  return {
    ...output,
    system: {
      ...output.system,
      containers: output.system.containers.map((c, i) => ({
        ...c,
        components: c.components.map((k, j) => ({
          ...k,
          globs: revised.get(ids.containers[i].components[j]) ?? k.globs,
        })),
      })),
    },
  };
}

function leftOver(check: GlobCheck, sha: string): string[] {
  const list = (items: string[]) => {
    const shown = items.slice(0, MAX_HEADER_PATHS).map((p) => `  ${p}`);
    if (items.length > MAX_HEADER_PATHS)
      shown.push(`  and ${items.length - MAX_HEADER_PATHS} more`);
    return shown;
  };
  if (check.unmatched.length === 0 && check.ambiguous.length === 0)
    return [`Every app file at ${sha} matches exactly one component.`];
  const lines: string[] = [];
  if (check.unmatched.length > 0)
    lines.push(
      `${plural(check.unmatched.length, "app file matches", "app files match")} no component:`,
      ...list(check.unmatched),
    );
  if (check.ambiguous.length > 0)
    lines.push(
      `${plural(check.ambiguous.length, "app file matches", "app files match")} more than one component:`,
      ...list(check.ambiguous.map((a) => `${a.file} ← ${a.ids.join(", ")}`)),
    );
  return lines;
}

export async function draftModel(opts: {
  root: string;
  runner?: Runner;
  onPhase?: (phase: string) => void;
}): Promise<DraftResult> {
  const started = Date.now();
  const runner = opts.runner ?? claudeRunner;
  const phase = opts.onPhase ?? (() => {});
  const sha = await gitLine(opts.root, ["rev-parse", "--verify", "HEAD"]);
  if (!sha) throw new Error("The repo has no commits to draft a model from.");
  const short = sha.slice(0, 7);
  // The same tracked files the snapshot holds, so the check sees what Claude saw.
  const { stdout } = await git(
    opts.root,
    ["ls-tree", "-r", "-z", "--name-only", sha],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const files = stdout.split("\0").filter(Boolean);

  return withSnapshot(opts.root, sha, async (dir) => {
    phase("Reading the code");
    const first = await runner<DraftOutput>(
      draftPrompt({ sha: short, files: files.length }),
      draftSchema(),
      dir,
    );
    let output = first.output;
    let costUsd = first.costUsd;

    phase("Checking globs");
    let check = checkGlobs(serializeModel(output), files);
    if (check.unmatched.length > 0 || check.ambiguous.length > 0) {
      const ids = assignIds(output);
      const unmatched = check.unmatched.slice(0, MAX_FIX_PATHS);
      const ambiguous = check.ambiguous.slice(
        0,
        MAX_FIX_PATHS - unmatched.length,
      );
      const fix = await runner<GlobFixOutput>(
        globFixPrompt({
          sha: short,
          unmatched,
          unmatchedCount: check.unmatched.length,
          ambiguous,
          ambiguousCount: check.ambiguous.length,
          components: output.system.containers.flatMap((c, i) =>
            c.components.map((k, j) => ({
              id: ids.containers[i].components[j],
              name: k.name,
              globs: k.globs,
            })),
          ),
        }),
        globFixSchema(),
        dir,
      );
      costUsd += fix.costUsd;
      output = applyFix(output, ids, fix.output);
      check = checkGlobs(serializeModel(output), files);
    }

    const durationMs = Date.now() - started;
    const model = first.model ?? flowsModel();
    const day = new Date().toISOString().slice(0, 10);
    // The cost is only here, not in the strip: Claude Code reports it at API
    // list prices even on a subscription, where a run isn't charged.
    const header = [
      `Drafted by Claude for differ on ${day}, from commit ${short}, with ${model}.`,
      "It's a draft, meant to be corrected: rename, merge and split components, and fix their globs.",
      `Delete the "differ.drafted" property once it's right, and the map stops calling it a draft.`,
      `The run took ${formatDuration(durationMs)}; Claude Code put its cost at $${costUsd.toFixed(2)} at API list prices.`,
      "",
      ...leftOver(check, short),
    ];
    return {
      dsl: serializeModel(output, { header, drafted: day }),
      costUsd,
      model,
      durationMs,
      unmatched: check.unmatched.length,
      ambiguous: check.ambiguous.length,
    };
  });
}

interface Job {
  status: DraftStatus;
  settled: Promise<void>;
}

const g = globalThis as { __differModels?: Map<string, Job> };
const jobs: Map<string, Job> = (g.__differModels ??= new Map());

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/**
 * Writes through a temp file and a rename, so the map never reads half a
 * model. The old model is copied to `.bak` only now, just before it's
 * replaced: a draft that fails leaves both untouched.
 */
async function writeModel(dir: string, dsl: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "workspace.dsl");
  const temp = path.join(dir, `.workspace.dsl.${process.pid}-${Date.now()}`);
  await fs.writeFile(temp, dsl, "utf8");
  try {
    if (await exists(file)) await fs.copyFile(file, `${file}.bak`);
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

export async function draftStatus(root: string): Promise<DraftStatus> {
  return (
    jobs.get(await localModelDir(root))?.status ?? {
      status: "idle",
    }
  );
}

/** The current job's end, for tests: nothing waits on a draft otherwise. */
export async function draftSettled(root: string): Promise<void> {
  await jobs.get(await localModelDir(root))?.settled;
}

export async function startDraft(
  root: string,
  opts: {
    redraft?: boolean;
    runner?: Runner;
    available?: () => Promise<boolean>;
  } = {},
): Promise<DraftStatus | DraftRefusal> {
  const dir = await localModelDir(root);
  const previous = jobs.get(dir);
  if (previous?.status.status === "running") return previous.status;
  // Claim the repo before the checks below, which wait: a second click
  // meanwhile sees this job rather than starting another.
  const running = {
    status: "running" as const,
    phase: "Starting",
    startedAt: Date.now(),
  };
  const job: Job = { status: running, settled: Promise.resolve() };
  jobs.set(dir, job);
  const refuse = (reason: DraftRefusal["reason"]): DraftRefusal => {
    if (previous) jobs.set(dir, previous);
    else jobs.delete(dir);
    return { status: "refused", reason };
  };

  if ((await showFile(root, "HEAD", MODEL_DSL)) !== null)
    return refuse("committed");
  if (!opts.redraft && (await exists(path.join(dir, "workspace.dsl"))))
    return refuse("exists");
  if (!(await (opts.available ?? claudeAvailable)())) {
    job.status = { status: "unavailable", reason: "no-claude" };
    return job.status;
  }

  job.settled = (async () => {
    try {
      const result = await draftModel({
        root,
        runner: opts.runner,
        onPhase: (phase) => (running.phase = phase),
      });
      await writeModel(dir, result.dsl);
      job.status = {
        status: "done",
        costUsd: result.costUsd,
        model: result.model,
        durationMs: result.durationMs,
        unmatched: result.unmatched,
        ambiguous: result.ambiguous,
      };
    } catch (err) {
      job.status = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();
  return running;
}
