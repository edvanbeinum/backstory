import { promises as fs } from "node:fs";
import path from "node:path";

import { AI_PROVIDERS, aiProvider, type Runner } from "../ai/provider";
import { gitLine } from "../exec";
import { repoKey } from "../flows/cache";
import { homeDir } from "../store";
import {
  deltaPatch,
  mergeDelta,
  readDelta,
  readHead,
  type DraftedDelta,
  type DraftedHead,
} from "./drafted";
import type { DataDraftStatus, DataModel } from "./types";

/**
 * Drafted data models and the reads that make them.
 *
 * `~/.backstory/data/<repo>/`: one file per head, `<headTree>.json`, and one
 * per delta, `<baseTree>..<headTree>.json`. Keyed by tree, not commit: the
 * model depends only on the files, so an amended message, a clean reorder or
 * a rebase that leaves a commit's files as they were reads from the cache. A
 * cache, safe to delete; after a prompt change, delete it.
 *
 * Reads run only on a click, one at a time: a head read on a large repo is a
 * few minutes and a dollar. Kept on globalThis, as `lib/flows/cache.ts`
 * keeps its runs, because Next may load this module once per route bundle.
 */

export interface DataView {
  root: string;
  base: string | null;
  head: string;
  /** `data.files` at the head: the files the head read is told hold the model */
  files?: string[] | null;
}

interface Read {
  /** The AI provider's id */
  provider: string;
  model: string | null;
  costUsd: number;
  readAt: number;
}

/** `files` is the `data.files` the head was read with; missing in files written before it, which read unsteered. */
type HeadFile = DraftedHead & Read & { files?: string[] | null };
/** `headReadAt` ties a delta to the head read it undid, so a redrafted head drops it. */
type DeltaFile = DraftedDelta & Read & { headReadAt: number };

interface Job {
  startedAt: number;
  phase: string;
  settled: Promise<void>;
}

interface Registry {
  jobs: Map<string, Job>;
  /** How the last read for a view ended, until the next one starts */
  ended: Map<string, DataDraftStatus>;
  queue: Promise<unknown>;
}

const g = globalThis as { __backstoryData?: Registry };
const registry: Registry = (g.__backstoryData ??= {
  jobs: new Map(),
  ended: new Map(),
  queue: Promise.resolve(),
});

interface Files {
  head: string;
  /** Null for a root commit, which has no base to read */
  delta: string | null;
  /** The view's key among the jobs */
  key: string;
}

const tree = async (root: string, rev: string) => {
  const t = await gitLine(root, ["rev-parse", "--verify", `${rev}^{tree}`]);
  if (!t) throw new Error(`No commit ${rev.slice(0, 7)} to read.`);
  return t;
};

async function filesFor(view: DataView): Promise<Files> {
  const dir = path.join(homeDir(), "data", await repoKey(view.root));
  const head = await tree(view.root, view.head);
  const base = view.base ? await tree(view.root, view.base) : null;
  const delta = base ? path.join(dir, `${base}..${head}.json`) : null;
  return {
    head: path.join(dir, `${head}.json`),
    delta,
    key: delta ?? path.join(dir, `root..${head}.json`),
  };
}

async function readJson<T>(file: string | null): Promise<T | null> {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, JSON.stringify(value, null, 1), "utf8");
  await fs.rename(temp, file);
}

/**
 * The head file, unless it was read with other `data.files` than the view
 * has now. The key is the tree, and editing the local model's steer doesn't
 * change the tree.
 */
async function headFile(files: Files, view: DataView) {
  const head = await readJson<HeadFile>(files.head);
  const same =
    JSON.stringify(head?.files ?? null) === JSON.stringify(view.files ?? null);
  return same ? head : null;
}

async function cached(files: Files, view: DataView) {
  const head = await headFile(files, view);
  if (!head) return null;
  const delta = await readJson<DeltaFile>(files.delta);
  const complete = !files.delta || delta?.headReadAt === head.readAt;
  return { head, delta: complete ? delta : null, complete };
}

const toModel = (entities: DraftedHead["entities"]): DataModel => ({
  source: "drafted",
  entities: new Map(entities.map((e) => [e.name, e])),
});

export const providerName = (id: string) =>
  AI_PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** The view's drafted models, base and head, when both reads are cached. */
export async function readDrafted(view: DataView): Promise<{
  base: DataModel | null;
  head: DataModel;
  provider: string;
  model: string | null;
} | null> {
  const hit = await cached(await filesFor(view), view);
  if (!hit?.complete) return null;
  return {
    base: hit.delta ? toModel(mergeDelta(hit.head.entities, hit.delta)) : null,
    head: toModel(hit.head.entities),
    provider: hit.head.provider,
    model: hit.head.model,
  };
}

export async function dataStatus(view: DataView): Promise<DataDraftStatus> {
  const files = await filesFor(view);
  const job = registry.jobs.get(files.key);
  if (job)
    return { status: "running", phase: job.phase, startedAt: job.startedAt };
  const idle = { status: "idle", provider: aiProvider().name } as const;
  const ended = registry.ended.get(files.key);
  // A done read whose files were deleted since is a view to read again.
  if (ended?.status === "done" && !(await cached(files, view))?.complete)
    return idle;
  return ended ?? idle;
}

/** The current read's end, for tests: nothing waits on a read otherwise. */
export async function dataReadSettled(view: DataView): Promise<void> {
  await registry.jobs.get((await filesFor(view)).key)?.settled;
}

function enqueue(fn: () => Promise<void>): Promise<void> {
  const next = registry.queue.then(fn, fn);
  registry.queue = next.catch(() => {});
  return next;
}

/**
 * Starts the view's read unless one is going or both halves are cached; a
 * view whose head is cached reads only the delta. Redraft reads both again
 * and replaces the files only when both succeed, so a failure keeps what
 * was paid for.
 */
export async function startDataRead(
  view: DataView,
  opts: {
    redraft?: boolean;
    runner?: Runner;
    available?: () => Promise<boolean>;
  } = {},
): Promise<DataDraftStatus> {
  const provider = aiProvider();
  const files = await filesFor(view);
  if (registry.jobs.has(files.key)) return dataStatus(view);
  // Claim the view before the checks below, which wait: a second click
  // meanwhile sees this job rather than starting another.
  let settle = () => {};
  const job: Job = {
    startedAt: Date.now(),
    phase: "Starting",
    settled: new Promise((resolve) => (settle = resolve)),
  };
  registry.jobs.set(files.key, job);
  const release = () => {
    registry.jobs.delete(files.key);
    settle();
  };

  try {
    const hit = await cached(files, view);
    if (!opts.redraft && hit?.complete) {
      release();
      return dataStatus(view);
    }
    if (!(await (opts.available ?? provider.available)())) {
      release();
      const status: DataDraftStatus = {
        status: "unavailable",
        provider: provider.name,
        setup: provider.setup,
      };
      registry.ended.set(files.key, status);
      return status;
    }
  } catch (err) {
    release();
    throw err;
  }

  registry.ended.delete(files.key);
  job.phase = "Waiting for another read";
  const runner = opts.runner ?? provider.run;
  void enqueue(async () => {
    const started = Date.now();
    let costUsd = 0;
    try {
      const patch = view.base
        ? await deltaPatch(view.root, view.base, view.head)
        : null;
      let head = opts.redraft ? null : await headFile(files, view);
      const writes: [string, unknown][] = [];
      if (!head) {
        job.phase = "Reading the head";
        const steer = view.files ?? null;
        const read = await readHead(view.root, view.head, runner, steer);
        costUsd += read.costUsd;
        head = {
          storage: read.output.storage,
          entities: read.output.entities,
          files: steer,
          provider: provider.id,
          model: read.model ?? provider.model(),
          costUsd: read.costUsd,
          readAt: Date.now(),
        };
        // A first read keeps the head even if the delta then fails, so Try
        // again pays for the delta only.
        if (opts.redraft) writes.push([files.head, head]);
        else await writeJson(files.head, head);
      }
      if (view.base && files.delta && patch !== null) {
        // Skip the read for an empty patch: the base's files are the head's,
        // so the provider would be paid to say nothing changed.
        job.phase = "Reading what the change undid";
        const read =
          patch === ""
            ? null
            : await readDelta(
                view.root,
                view.base,
                head,
                patch,
                runner,
                view.files ?? null,
              );
        costUsd += read?.costUsd ?? 0;
        writes.push([
          files.delta,
          {
            changed: read?.output.changed ?? [],
            absent: read?.output.absent ?? [],
            provider: provider.id,
            model: read ? (read.model ?? provider.model()) : null,
            costUsd: read?.costUsd ?? 0,
            readAt: Date.now(),
            headReadAt: head.readAt,
          } satisfies DeltaFile,
        ]);
      }
      for (const [file, value] of writes) await writeJson(file, value);
      registry.ended.set(files.key, {
        status: "done",
        costUsd,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      registry.ended.set(files.key, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      release();
    }
  });
  return { status: "running", phase: job.phase, startedAt: job.startedAt };
}
