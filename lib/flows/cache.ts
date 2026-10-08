import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { gitLine } from "../exec";
import { homeDir } from "../store";
import { claudeAvailable } from "./claude";
import { attachComponents } from "./components";
import { generateFlows, traceHunk } from "./generate";
import { fromSarif, toSarif, type SarifLog } from "./sarif";
import type { FlowSet, FlowsStatus } from "./types";

/**
 * Cached flows and the runs that make them.
 *
 * One file per view, `~/.backstory/flows/<repo>/<base>..<head>.sarif.json`. Not
 * in `lib/store.ts`: that's a few KB of click-driven JSON read and written
 * whole; these are ~15 KB each, one per view. After a prompt change, delete
 * the folder.
 *
 * Runs are in memory and one at a time: each is a minute of Claude Code, and
 * two at once would just both be slow. Kept on globalThis, as lib/review.ts
 * does, because Next may load this module once per route bundle.
 */

export interface View {
  /** The worktree root asking, for the watch stream's event */
  root: string;
  base: string | null;
  head: string;
}

interface Job {
  startedAt: number;
  phase: string;
}

interface Registry {
  jobs: Map<string, Job>;
  tracing: Map<string, Set<string>>;
  failures: Map<string, string>;
  queue: Promise<unknown>;
  claude: boolean | null;
  events: EventEmitter;
}

const g = globalThis as { __backstoryFlows?: Registry };
const registry: Registry = (g.__backstoryFlows ??= {
  jobs: new Map(),
  tracing: new Map(),
  failures: new Map(),
  queue: Promise.resolve(),
  claude: null,
  events: new EventEmitter().setMaxListeners(0),
});

/** Worktrees of one repo share their flows: the key is the common git dir. */
async function repoDir(root: string): Promise<string> {
  const common =
    (await gitLine(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])) ?? root;
  const name = path
    .basename(path.dirname(common))
    .replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = createHash("sha1").update(common).digest("hex").slice(0, 8);
  return path.join(homeDir(), "flows", `${name}-${hash}`);
}

const fileName = (view: View) =>
  `${view.base ?? "root"}..${view.head}.sarif.json`;
const jobKey = (dir: string, view: View) => path.join(dir, fileName(view));

async function readCache(file: string): Promise<FlowSet | null> {
  try {
    return fromSarif(JSON.parse(await fs.readFile(file, "utf8")) as SarifLog);
  } catch {
    return null;
  }
}

async function writeCache(file: string, set: FlowSet, root: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(toSarif(set, `file://${root}`), null, 1),
    "utf8",
  );
}

export function onFlowsChange(listener: (root: string) => void): () => void {
  registry.events.on("change", listener);
  return () => registry.events.off("change", listener);
}

export async function flowsStatus(view: View): Promise<FlowsStatus> {
  const key = jobKey(await repoDir(view.root), view);
  const job = registry.jobs.get(key);
  if (job)
    return { status: "running", startedAt: job.startedAt, phase: job.phase };
  const cached = await readCache(key);
  if (cached) {
    return {
      status: "ready",
      flows: await attachComponents(view.root, cached),
      tracing: [...(registry.tracing.get(key) ?? [])],
      runError: registry.failures.get(key),
    };
  }
  const failure = registry.failures.get(key);
  if (failure) return { status: "failed", error: failure };
  return { status: "idle" };
}

function enqueue(fn: () => Promise<void>) {
  const next = registry.queue.then(fn, fn);
  registry.queue = next.catch(() => {});
}

async function haveClaude() {
  registry.claude ??= await claudeAvailable();
  return registry.claude;
}

/** Start a run for the view unless one is going. Regenerate drops the cache. */
export async function startFlows(
  view: View,
  opts: { regenerate?: boolean } = {},
): Promise<FlowsStatus> {
  if (!(await haveClaude())) {
    registry.claude = null; // look again next time: it may have been installed
    return { status: "unavailable", reason: "no-claude" };
  }
  const key = jobKey(await repoDir(view.root), view);
  if (registry.jobs.has(key)) return flowsStatus(view);
  // Regenerating replaces the cached flows only when the new run succeeds:
  // a failure keeps what was paid for. Runs share one queue, so a hunk's
  // run already queued finishes first and this run's result replaces it.
  if (!opts.regenerate && (await readCache(key))) return flowsStatus(view);

  const job: Job = { startedAt: Date.now(), phase: "Waiting for another run" };
  registry.jobs.set(key, job);
  registry.failures.delete(key);
  enqueue(async () => {
    try {
      job.phase = "Starting";
      const set = await generateFlows({
        root: view.root,
        base: view.base,
        head: view.head,
        onPhase: (phase) => (job.phase = phase),
      });
      await writeCache(key, set, view.root);
    } catch (err) {
      registry.failures.set(
        key,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      registry.jobs.delete(key);
      registry.events.emit("change", view.root);
    }
  });
  return flowsStatus(view);
}

/** "Trace a flow from here": one more flow for a hunk on none. */
export async function startTrace(
  view: View,
  hunkId: string,
): Promise<FlowsStatus> {
  if (!(await haveClaude()))
    return { status: "unavailable", reason: "no-claude" };
  const key = jobKey(await repoDir(view.root), view);
  const tracing = registry.tracing.get(key) ?? new Set<string>();
  if (tracing.has(hunkId)) return flowsStatus(view);
  tracing.add(hunkId);
  registry.tracing.set(key, tracing);
  registry.failures.delete(key);

  enqueue(async () => {
    try {
      const set = await readCache(key);
      if (!set) return;
      const next = await traceHunk({
        root: view.root,
        base: view.base,
        head: view.head,
        set,
        hunkId,
      });
      await writeCache(key, next, view.root);
    } catch (err) {
      registry.failures.set(
        key,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      tracing.delete(hunkId);
      registry.events.emit("change", view.root);
    }
  });
  return flowsStatus(view);
}
