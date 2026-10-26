import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AI_PROVIDERS,
  aiProvider,
  providerGap,
  type AiProvider,
  type ProviderStatus,
  type Runner,
} from "../ai/provider";
import { BIG_REPO_FILES } from "../constants";
import { gitLine, gitTry } from "../exec";
import { isOnBranch, repoKey, resolveRepo } from "../git";
import { readModelAt } from "../model";
import { homeDir, setSetting, setting } from "../store";
import {
  forwardPatch,
  mergeDelta,
  readDelta,
  readHead,
  type DraftedHead,
} from "./drafted";
import { dataSteer, readDataModel, steerError } from "./readers";
import type { DataDraftStatus, DataModel, TrunkReadStatus } from "./types";

/**
 * Drafted data models and the reads that make them.
 *
 * `~/.backstory/data/<repo>/` has one file per tree, `<tree>.json`: the model
 * at that tree, with `from`, the tree it was derived from, null for a read in
 * full. Keyed by tree, not commit: the model depends only on the files, so an
 * amended message, a clean reorder or a rebase that leaves a commit's files
 * as they were reads from the cache. A cache, safe to delete; after a prompt
 * change, delete it.
 *
 * A model is derived forward from the nearest model Backstory already has:
 * the provider is given that model and the patch from its tree to this one,
 * one small read (`modelAt`). A view derives its base from main's model, then
 * its head from its base, so a branch pays for its own patch, and the first
 * branch forked at a point pays for main's drift up to it, once.
 *
 * Main's model is the one `trunk.json` points at: its tree, commit and steer.
 * Main is the repo's default branch, at origin when that ref exists. It is
 * read in full once per repo (`startTrunkRead`) and never again on its own.
 * When a view's base is on main and past main's model, the read the base
 * needed anyway is main's drift, and main's model moves to the base. Main is
 * read in full again only when the patch from main's model to a commit on
 * main is past the cap, which reads that commit in full and, when it is past
 * main's model, makes it main's model, or on Redraft. Redraft reads main in full again and removes every
 * derived model, since an error in main's model is copied into each of them.
 *
 * Reads run one at a time, to keep within the user's usage limits: a full
 * read on a large repo is a few minutes. They start as a repo and a view
 * open, unless the user turned the repo off (`autoRead`), or on a click. Kept
 * on globalThis, as `lib/flows/cache.ts` keeps its
 * runs, because Next may load this module once per route bundle.
 */

export interface DataView {
  root: string;
  base: string | null;
  head: string;
  /** `data.files` at the head: the files the reads are told have the model */
  files?: string[] | null;
}

interface Read {
  /** The AI provider's id */
  provider: string;
  model: string | null;
  costUsd: number;
  readAt: number;
}

/**
 * The model at a tree. `files` is the `data.files` it was read with; `from`
 * is the tree it was derived from, null or missing for a read in full.
 */
type ModelFile = DraftedHead &
  Read & { files?: string[] | null; from?: string | null };

/** What `trunk.json` says: main's model's tree, its commit, and the steer it was read with */
interface Trunk {
  tree: string;
  commit: string;
  files: string[] | null;
}

interface Job {
  startedAt: number;
  phase: string;
  /** The tree the read is on, from 1, or 0 before its first */
  at: number;
  /** How many trees the read reads, main's first when it waits on main */
  of: number;
  /** For main's read: whether the repo is big, once its files are counted */
  big?: boolean;
  settled: Promise<void>;
  /** The key of main's read, when this job was queued behind it */
  behind?: string;
}

interface Registry {
  jobs: Map<string, Job>;
  /** How the last read for a view, or for a repo's main, ended, until the next one starts */
  ended: Map<string, DataDraftStatus>;
  queue: Promise<unknown>;
}

const g = globalThis as { __backstoryData?: Registry };
const registry: Registry = (g.__backstoryData ??= {
  jobs: new Map(),
  ended: new Map(),
  queue: Promise.resolve(),
});

export const PHASES = {
  waiting: "Waiting for another read",
  main: "Reading main's data model first",
  firstMain:
    "Reading main's data model first, so each change after this is quick",
  base: "Reading what the base changed since main",
  baseInFull: "Reading the base",
  head: "Reading this change",
};

const offKey = async (root: string) => `read.off.${await repoKey(root)}`;

/**
 * Whether maps, data models and change descriptions read as the repo and its
 * views open: on unless the user turned the repo off. Keyed by repo, so every
 * worktree shares it.
 */
export const autoRead = async (root: string) =>
  setting(await offKey(root)) !== "1";
export const setAutoRead = async (root: string, on: boolean) =>
  setSetting(await offKey(root), on ? "0" : "1");

/** Whether the repo tracks `BIG_REPO_FILES` files or more. */
export async function bigRepo(root: string): Promise<boolean> {
  const out = await gitTry(root, ["ls-files", "-z"]);
  return (out?.split("\0").length ?? 1) - 1 >= BIG_REPO_FILES;
}

interface Files {
  dir: string;
  head: string;
  /** Null for a root commit, which has no base to read */
  base: string | null;
  /** The view's key among the jobs */
  key: string;
}

const tree = async (root: string, rev: string) => {
  const t = await gitLine(root, ["rev-parse", "--verify", `${rev}^{tree}`]);
  if (!t) throw new Error(`No commit ${rev.slice(0, 7)} to read.`);
  return t;
};

const dataDir = async (root: string) =>
  path.join(homeDir(), "data", await repoKey(root));
const modelPath = (dir: string, t: string) => path.join(dir, `${t}.json`);
const trunkPath = (dir: string) => path.join(dir, "trunk.json");
const trunkKey = (dir: string) => path.join(dir, "trunk");

async function filesFor(view: DataView): Promise<Files> {
  const dir = await dataDir(view.root);
  const head = await tree(view.root, view.head);
  const base = view.base ? await tree(view.root, view.base) : null;
  return { dir, head, base, key: path.join(dir, `${base ?? "root"}..${head}`) };
}

async function readJson<T>(file: string): Promise<T | null> {
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

const sameSteer = (a?: string[] | null, b?: string[] | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The saved model at a tree, unless it was read with other `data.files` than
 * the view has now. The key is the tree, and editing the local model's steer
 * doesn't change the tree.
 */
async function savedModel(dir: string, t: string, files?: string[] | null) {
  const model = await readJson<ModelFile>(modelPath(dir, t));
  return model && sameSteer(model.files, files) ? model : null;
}

/** Main's saved model, when it was read with this steer. */
async function savedTrunk(dir: string, files?: string[] | null) {
  const pointer = await readJson<Trunk>(trunkPath(dir));
  if (!pointer || !sameSteer(pointer.files, files)) return null;
  const model = await savedModel(dir, pointer.tree, files);
  return model ? { pointer, model } : null;
}

async function cached(files: Files, view: DataView) {
  const head = await savedModel(files.dir, files.head, view.files);
  if (!head) return null;
  if (!files.base) return { base: null, head };
  const base = await savedModel(files.dir, files.base, view.files);
  return base ? { base, head } : null;
}

const toModel = (entities: DraftedHead["entities"]): DataModel => ({
  source: "drafted",
  entities: new Map(entities.map((e) => [e.name, e])),
});

export const providerName = (id: string) =>
  AI_PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** The view's drafted models, base and head, when both are saved. */
export async function readDrafted(view: DataView): Promise<{
  base: DataModel | null;
  head: DataModel;
  /** The head's sentence on where the data is stored; missing from a model saved before it was asked for */
  storage?: string;
  provider: string;
  model: string | null;
} | null> {
  const files = await filesFor(view);
  const hit = await cached(files, view);
  if (!hit) return null;
  return {
    base: hit.base ? toModel(hit.base.entities) : null,
    head: toModel(hit.head.entities),
    ...(hit.head.storage ? { storage: hit.head.storage } : {}),
    provider: hit.head.provider,
    model: hit.head.model,
  };
}

export async function dataStatus(
  view: DataView,
  status?: () => Promise<ProviderStatus>,
): Promise<DataDraftStatus> {
  const files = await filesFor(view);
  const job = registry.jobs.get(files.key);
  if (job) {
    // Queued behind main's read, the view shows main's progress: the wait is
    // the first step of its own read.
    const main =
      job.behind && job.phase === PHASES.waiting
        ? registry.jobs.get(job.behind)
        : undefined;
    if (main)
      return {
        status: "running",
        phase: main.phase === PHASES.firstMain ? PHASES.main : main.phase,
        startedAt: main.startedAt,
        step: { at: 1, of: Math.max(job.of, 1) },
      };
    return {
      status: "running",
      phase: job.phase,
      startedAt: job.startedAt,
      step: stepOf(job),
    };
  }
  const idle = {
    status: "idle",
    provider: aiProvider().name,
    auto: await autoRead(view.root),
  } as const;
  const ended = registry.ended.get(files.key);
  // A done read whose files were deleted since is a view to read again.
  if (ended?.status === "done" && !(await cached(files, view))) return idle;
  // Ask the provider again while it was missing or signed out, so installing
  // or signing in brings the read back without a restart.
  if (ended?.status === "unavailable") {
    const reason = providerGap(await (status ?? aiProvider().status)());
    if (!reason) {
      registry.ended.delete(files.key);
      return idle;
    }
    registry.ended.set(files.key, { ...ended, reason });
    return { ...ended, reason };
  }
  return ended ?? idle;
}

const stepOf = (job: Job) =>
  job.at > 0 ? { at: job.at, of: Math.max(job.of, job.at) } : null;

/** Main's read for the repo: running, or how it last ended; null when none ran. */
export async function dataTrunkStatus(
  root: string,
): Promise<TrunkReadStatus | null> {
  const key = trunkKey(await dataDir(root));
  const job = registry.jobs.get(key);
  if (job)
    return {
      status: "running",
      phase: job.phase,
      startedAt: job.startedAt,
      step: stepOf(job),
      big: job.big ?? false,
    };
  const ended = registry.ended.get(key);
  return ended?.status === "done" || ended?.status === "failed" ? ended : null;
}

/** The end of the view's current read, if one is running: the change description waits on it, as tests do. */
export async function dataReadSettled(view: DataView): Promise<void> {
  await registry.jobs.get((await filesFor(view)).key)?.settled;
}

/** The end of the repo's read of main, for tests. */
export async function trunkReadSettled(root: string): Promise<void> {
  await registry.jobs.get(trunkKey(await dataDir(root)))?.settled;
}

function enqueue(fn: () => Promise<void>): Promise<void> {
  const next = registry.queue.then(fn, fn);
  registry.queue = next.catch(() => {});
  return next;
}

/**
 * Registers a job under `key` before any check that waits, so a second
 * request meanwhile sees this job rather than starting another.
 */
function claim(key: string) {
  let settle = () => {};
  const job: Job = {
    startedAt: Date.now(),
    phase: "Starting",
    at: 0,
    of: 0,
    settled: new Promise((resolve) => (settle = resolve)),
  };
  registry.jobs.set(key, job);
  const release = () => {
    registry.jobs.delete(key);
    settle();
  };
  return { job, release };
}

/** Main's tip: the default branch at origin when that ref exists, else the local branch, as the fork point takes it. */
async function mainTip(root: string): Promise<string | null> {
  const branch = (await resolveRepo(root)).defaultBranch;
  if (!branch) return null;
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const sha = await gitLine(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (sha) return sha;
  }
  return null;
}

const mainSteer = async (root: string, tip: string) =>
  dataSteer((await readModelAt(root, tip))?.model?.properties);

/** One job's reads: where they go, how they run, and what they made. */
interface Chain {
  root: string;
  dir: string;
  files: string[] | null;
  runner: Runner;
  provider: AiProvider;
  job: Job;
  /** Ignore saved models and write nothing until the end: Redraft */
  fresh: boolean;
  /** Models this job made, by tree */
  made: Map<string, ModelFile>;
  costUsd: number;
}

function chain(
  root: string,
  dir: string,
  files: string[] | null,
  job: Job,
  opts: { runner?: Runner; fresh?: boolean },
): Chain {
  const provider = aiProvider();
  return {
    root,
    dir,
    files,
    runner: opts.runner ?? provider.run,
    provider,
    job,
    fresh: opts.fresh ?? false,
    made: new Map(),
    costUsd: 0,
  };
}

/**
 * The model at a tree: saved, or derived from `start` by one forward delta
 * read, or, with no start or a patch from it past the cap, read in full.
 * Written as soon as it's read, so a later read that fails keeps it.
 */
async function modelAt(
  c: Chain,
  at: { tree: string; rev: string },
  start: { tree: string; model: ModelFile } | null,
  phases: { delta?: string; full: string },
): Promise<ModelFile> {
  const made = c.made.get(at.tree);
  if (made) return made;
  if (!c.fresh) {
    const saved = await savedModel(c.dir, at.tree, c.files);
    if (saved) return saved;
  }
  c.job.at += 1;
  const patch = start ? await forwardPatch(c.root, start.tree, at.tree) : null;
  let model: ModelFile;
  if (start && patch === "") {
    model = {
      ...start.model,
      from: start.tree,
      costUsd: 0,
      readAt: Date.now(),
    };
  } else if (start && patch !== null) {
    c.job.phase = phases.delta ?? phases.full;
    const read = await readDelta(
      c.root,
      at.rev,
      start.model,
      patch,
      c.runner,
      c.files,
    );
    model = {
      storage: start.model.storage,
      entities: mergeDelta(start.model.entities, read.output),
      files: c.files,
      from: start.tree,
      provider: c.provider.id,
      model: read.model ?? c.provider.model(),
      costUsd: read.costUsd,
      readAt: Date.now(),
    };
  } else {
    c.job.phase = phases.full;
    const read = await readHead(c.root, at.rev, c.runner, c.files);
    model = {
      storage: read.output.storage,
      entities: read.output.entities,
      files: c.files,
      from: null,
      provider: c.provider.id,
      model: read.model ?? c.provider.model(),
      costUsd: read.costUsd,
      readAt: Date.now(),
    };
  }
  c.costUsd += model.costUsd;
  c.made.set(at.tree, model);
  if (!c.fresh) await writeJson(modelPath(c.dir, at.tree), model);
  return model;
}

/**
 * How many trees `readView` reads: main's on a Redraft, then the base and the
 * head unless saved, each tree once.
 */
async function treesToRead(
  c: Chain,
  view: DataView,
  files: Files,
): Promise<number> {
  const main = c.fresh ? await mainTip(c.root) : null;
  const unread = new Set<string>();
  for (const t of [
    main && (await tree(c.root, main)),
    view.base && files.base,
    files.head,
  ]) {
    if (!t || unread.has(t)) continue;
    if (c.fresh || !(await savedModel(c.dir, t, c.files))) unread.add(t);
  }
  return unread.size;
}

/**
 * The view's base from main's model, then its head from its base. Moves main's
 * model to the base when the base is on main and past it. Returns main's
 * pointer when this job changed it.
 */
async function readView(
  c: Chain,
  view: DataView,
  files: Files,
): Promise<Trunk | null> {
  const main = await mainTip(c.root);
  let trunk: { pointer: Trunk; model: ModelFile } | null = null;
  let moved: Trunk | null = null;
  if (c.fresh && main) {
    const t = await tree(c.root, main);
    const model = await modelAt(c, { tree: t, rev: main }, null, {
      full: PHASES.main,
    });
    moved = { tree: t, commit: main, files: c.files };
    trunk = { pointer: moved, model };
  } else if (!c.fresh) {
    // A Redraft with no main to read again reads the base in full, rather
    // than from the old main's model it is meant to replace.
    trunk = await savedTrunk(c.dir, c.files);
  }

  let base: { tree: string; model: ModelFile } | null = null;
  if (view.base && files.base) {
    const start = trunk && { tree: trunk.pointer.tree, model: trunk.model };
    const model = await modelAt(
      c,
      { tree: files.base, rev: view.base },
      start,
      { delta: PHASES.base, full: PHASES.baseInFull },
    );
    base = { tree: files.base, model };
    // Move a pointer read with other `data.files` only for a view with main's
    // own steer: a branch that edits the steer would otherwise take it over,
    // and once main edits it, main's views must take it, or every base is read
    // in full. Replace a commit main no longer reaches, as after a force-push,
    // or main's model would never move again.
    const pointer = trunk?.pointer ?? (await readJson<Trunk>(trunkPath(c.dir)));
    const past = !pointer
      ? true
      : !trunk
        ? !!main && sameSteer((await mainSteer(c.root, main)).files, c.files)
        : trunk.pointer.commit !== view.base &&
          ((await isOnBranch(c.root, trunk.pointer.commit, view.base)) ||
            (!!main &&
              !(await isOnBranch(c.root, trunk.pointer.commit, main))));
    if (main && past && (await isOnBranch(c.root, view.base, main))) {
      moved = { tree: files.base, commit: view.base, files: c.files };
      if (!c.fresh) await writeJson(trunkPath(c.dir), moved);
    }
  }

  await modelAt(c, { tree: files.head, rev: view.head }, base, {
    full: PHASES.head,
  });
  return moved;
}

/**
 * Saves a redraft once every read in it succeeded: removes the repo's derived
 * models, which may have copied an error from the old main, then writes the
 * new ones.
 */
async function saveRedraft(c: Chain, trunk: Trunk | null) {
  for (const name of await fs.readdir(c.dir).catch(() => [])) {
    const t = /^([0-9a-f]+)\.json$/.exec(name)?.[1];
    if (!t || c.made.has(t)) continue;
    const file = await readJson<ModelFile>(path.join(c.dir, name));
    if (file?.from) await fs.rm(path.join(c.dir, name), { force: true });
  }
  for (const [t, model] of c.made) await writeJson(modelPath(c.dir, t), model);
  if (trunk) await writeJson(trunkPath(c.dir), trunk);
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Starts the view's read unless one is going or both ends are saved. Redraft
 * reads main and the view again and saves only when every read succeeds, so
 * a failure keeps what was paid for.
 */
export async function startDataRead(
  view: DataView,
  opts: {
    redraft?: boolean;
    runner?: Runner;
    status?: () => Promise<ProviderStatus>;
  } = {},
): Promise<DataDraftStatus> {
  const provider = aiProvider();
  const files = await filesFor(view);
  if (registry.jobs.has(files.key)) return dataStatus(view);
  const { job, release } = claim(files.key);

  try {
    if (!opts.redraft && (await cached(files, view))) {
      release();
      return dataStatus(view);
    }
    const gap = providerGap(await (opts.status ?? provider.status)());
    if (gap) {
      release();
      const status: DataDraftStatus = {
        status: "unavailable",
        provider: provider.name,
        reason: gap,
      };
      registry.ended.set(files.key, status);
      return status;
    }
  } catch (err) {
    release();
    throw err;
  }

  registry.ended.delete(files.key);
  job.phase = PHASES.waiting;
  const main = trunkKey(files.dir);
  // Count main's read as a step only once it's queued: before then it may
  // find main saved and end without reading.
  if (registry.jobs.get(main)?.of) job.behind = main;
  const c = chain(view.root, files.dir, view.files ?? null, job, {
    runner: opts.runner,
    fresh: opts.redraft,
  });
  const behind = job.behind ? 1 : 0;
  job.of = behind + (await treesToRead(c, view, files).catch(() => 0));
  void enqueue(async () => {
    const started = Date.now();
    try {
      // Main's read just failed with the same provider: a full read of the
      // base instead would cost as much and fail the same way.
      const mainEnded = job.behind ? registry.ended.get(job.behind) : null;
      if (mainEnded?.status === "failed") throw new Error(mainEnded.error);
      // Count again: main's read, or another view's, may have saved a tree
      // since, and main's read ends without reading when one already had.
      const read = mainEnded ? 1 : 0;
      job.at = read;
      job.of = await treesToRead(c, view, files).then(
        (n) => read + n,
        () => job.of,
      );
      const trunk = await readView(c, view, files);
      if (c.fresh) await saveRedraft(c, trunk);
      registry.ended.set(files.key, {
        status: "done",
        costUsd: c.costUsd,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      registry.ended.set(files.key, { status: "failed", error: message(err) });
    } finally {
      release();
    }
  });
  return dataStatus(view);
}

/** Main's tip and steer, when main has a model to draft and none is saved. */
async function trunkToRead(
  root: string,
  dir: string,
  status?: () => Promise<ProviderStatus>,
): Promise<{ tip: string; files: string[] | null } | null> {
  const tip = await mainTip(root);
  if (!tip || (await readJson<Trunk>(trunkPath(dir)))) return null;
  const steer = await mainSteer(root, tip);
  if (steerError(steer) || (await readDataModel(root, tip, steer))) return null;
  if (providerGap(await (status ?? aiProvider().status)())) return null;
  return { tip, files: steer.files };
}

/**
 * Starts reading main's model in full, when the repo has no saved main model,
 * no data reader reads it at main, and the provider is ready. True when a
 * read was queued. Not after this read failed: every repo open asks, and a
 * read can fail after it's been paid for. A view's read in full of a base on
 * main, or Redraft, makes main's model instead.
 */
export async function startTrunkRead(
  root: string,
  opts: { runner?: Runner; status?: () => Promise<ProviderStatus> } = {},
): Promise<boolean> {
  const dir = await dataDir(root);
  const key = trunkKey(dir);
  if (registry.jobs.has(key) || registry.ended.get(key)?.status === "failed")
    return false;
  const { job, release } = claim(key);

  let ready: { tip: string; files: string[] | null } | null = null;
  try {
    ready = await trunkToRead(root, dir, opts.status);
  } finally {
    if (!ready) release();
  }
  if (!ready) return false;

  registry.ended.delete(key);
  job.phase = PHASES.waiting;
  job.of = 1;
  const { tip, files } = ready;
  const c = chain(root, dir, files, job, { runner: opts.runner });
  void enqueue(async () => {
    const started = Date.now();
    try {
      // A view's read queued ahead of this one may have saved main's model.
      if (await readJson<Trunk>(trunkPath(dir))) return;
      job.big = await bigRepo(root);
      const t = await tree(root, tip);
      await modelAt(c, { tree: t, rev: tip }, null, {
        full: PHASES.firstMain,
      });
      await writeJson(trunkPath(dir), { tree: t, commit: tip, files });
      registry.ended.set(key, {
        status: "done",
        costUsd: c.costUsd,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      registry.ended.set(key, { status: "failed", error: message(err) });
    } finally {
      release();
    }
  });
  return true;
}
