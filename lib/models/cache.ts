import { promises as fs } from "node:fs";
import path from "node:path";

import {
  aiProvider,
  providerGap,
  type AiProvider,
  type ProviderStatus,
  type Runner,
} from "../ai/provider";
import { autoRead } from "../data/cache";
import { forwardPatch } from "../data/drafted";
import type { DataDraftStatus } from "../data/types";
import { gitLine } from "../exec";
import { isOnBranch, repoKey, resolveRepo } from "../git";
import {
  handWrittenModel,
  MODEL_DSL,
  showFile,
  type Workspace,
} from "../model";
import { homeDir } from "../store";
import { mergeMapDelta, readMapDelta } from "./delta";
import { draftModel } from "./draft";

/**
 * Drafted maps and the reads that make them, for a repo that neither commits
 * a C4 model nor has a hand-written local one. The data cache's engine
 * (`lib/data/cache.ts`), copied for the map, with its own queue.
 *
 * `~/.backstory/maps/<repo>/` has one file per tree, `<tree>.json`: the map
 * at that tree as a `Workspace`, with `from`, the tree it was derived from,
 * null for a read in full. Keyed by tree, not commit: the map depends only on
 * the files, so an amended message, a clean reorder or a rebase that leaves a
 * commit's files as they were reads from the cache. A cache, safe to delete;
 * after a prompt change, delete it.
 *
 * A map is derived forward from the nearest map Backstory already has: the
 * provider is given that map and the patch from its tree to this one, one
 * small read (`mapAt`). A view derives its base from main's map, then its
 * head from its base, so a branch pays for its own patch, and the first
 * branch forked at a point pays for main's drift up to it, once.
 *
 * Main's map is the one `trunk.json` points at: its tree and commit. Main is
 * the repo's default branch, at origin when that ref exists. It is read in
 * full once per repo (`startMapTrunkRead`) and never again on its own. When a
 * view's base is on main and past main's map, the read the base needed anyway
 * is main's drift, and main's map moves to the base. Main is read in full
 * again only when the patch from main's map to a commit on main is past the
 * cap, which reads that commit in full and, when it is past main's map, makes
 * it main's map, or on Redraft. Redraft reads main in full again and removes
 * every derived map, since an error in main's map is copied into each of
 * them.
 *
 * Reads run one at a time, apart from the data cache's: a full read on a
 * large repo is a few minutes. They start on a click, or, once the user turns
 * on reading automatically (`autoRead`), as a repo and a view open. Kept on
 * globalThis, as `lib/flows/cache.ts` keeps its runs, because Next may load
 * this module once per route bundle.
 */

export interface MapView {
  root: string;
  base: string | null;
  head: string;
}

/** A map read's status for one view, in the data model's shape */
export type MapDraftStatus = DataDraftStatus;

/** Why a map isn't drafted: the repo commits a model, or has a hand-written one. */
export interface MapRefusal {
  status: "refused";
  reason: "committed" | "local";
}

/** The map at a tree. `from` is the tree it was derived from, null for a read in full. */
interface MapFile {
  workspace: Workspace;
  from: string | null;
  /** The AI provider's id */
  provider: string;
  model: string | null;
  costUsd: number;
  readAt: number;
}

/** What `trunk.json` says: main's map's tree and its commit */
interface Trunk {
  tree: string;
  commit: string;
}

interface Job {
  startedAt: number;
  phase: string;
  settled: Promise<void>;
  /** The key of main's read, when this job was queued behind it */
  behind?: string;
}

interface Registry {
  jobs: Map<string, Job>;
  /** How the last read for a view, or for a repo's main, ended, until the next one starts */
  ended: Map<string, MapDraftStatus>;
  queue: Promise<unknown>;
}

const g = globalThis as { __backstoryMaps?: Registry };
const registry: Registry = (g.__backstoryMaps ??= {
  jobs: new Map(),
  ended: new Map(),
  queue: Promise.resolve(),
});

export const PHASES = {
  waiting: "Waiting for another read",
  main: "Reading main's map first",
  firstMain: "Reading main's map first, so each change after this is quick",
  base: "Reading what the base changed since main",
  baseInFull: "Reading the base",
  head: "Reading this change",
};

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

const mapsDir = async (root: string) =>
  path.join(homeDir(), "maps", await repoKey(root));
const mapPath = (dir: string, t: string) => path.join(dir, `${t}.json`);
const trunkPath = (dir: string) => path.join(dir, "trunk.json");
const trunkKey = (dir: string) => path.join(dir, "trunk");

async function filesFor(view: MapView): Promise<Files> {
  const dir = await mapsDir(view.root);
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

const savedMap = (dir: string, t: string) => readJson<MapFile>(mapPath(dir, t));

async function savedTrunk(dir: string) {
  const pointer = await readJson<Trunk>(trunkPath(dir));
  if (!pointer) return null;
  const map = await savedMap(dir, pointer.tree);
  return map ? { pointer, map } : null;
}

async function cached(files: Files) {
  const head = await savedMap(files.dir, files.head);
  if (!head) return null;
  if (!files.base) return { base: null, head };
  const base = await savedMap(files.dir, files.base);
  return base ? { base, head } : null;
}

/**
 * The drafted map saved for the rev's tree, for `readModelAt`. Returns the
 * `Workspace`, not a model: `lib/model.ts` builds it, and this module can't
 * import that at load time.
 */
export async function savedMapAt(
  root: string,
  rev: string,
): Promise<{ workspace: Workspace; readAt: number } | null> {
  const t = await gitLine(root, ["rev-parse", "--verify", `${rev}^{tree}`]);
  if (!t) return null;
  const map = await savedMap(await mapsDir(root), t);
  return map ? { workspace: map.workspace, readAt: map.readAt } : null;
}

/** Why the map at the rev isn't drafted, or null when it may be. */
export async function mapRefusal(
  root: string,
  rev: string,
): Promise<MapRefusal | null> {
  if ((await showFile(root, rev, MODEL_DSL)) !== null)
    return { status: "refused", reason: "committed" };
  if (await handWrittenModel(root))
    return { status: "refused", reason: "local" };
  return null;
}

export async function mapStatus(view: MapView): Promise<MapDraftStatus> {
  const files = await filesFor(view);
  const job = registry.jobs.get(files.key);
  if (job) {
    // Queued behind main's read, the view shows main's progress: the wait is
    // the first step of its own read.
    const main =
      job.behind && job.phase === PHASES.waiting
        ? registry.jobs.get(job.behind)
        : undefined;
    const shown = main ?? job;
    return {
      status: "running",
      phase: shown.phase,
      startedAt: shown.startedAt,
    };
  }
  const idle = {
    status: "idle",
    provider: aiProvider().name,
    auto: autoRead(),
  } as const;
  const ended = registry.ended.get(files.key);
  // A done read whose files were deleted since is a view to read again.
  if (ended?.status === "done" && !(await cached(files))) return idle;
  return ended ?? idle;
}

/** The current read's end, for tests: nothing waits on a read otherwise. */
export async function mapReadSettled(view: MapView): Promise<void> {
  await registry.jobs.get((await filesFor(view)).key)?.settled;
}

/** The end of the repo's read of main's map, for tests. */
export async function mapTrunkReadSettled(root: string): Promise<void> {
  await registry.jobs.get(trunkKey(await mapsDir(root)))?.settled;
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

/** One job's reads: where they go, how they run, and what they made. */
interface Chain {
  root: string;
  dir: string;
  runner: Runner;
  provider: AiProvider;
  job: Job;
  /** Ignore saved maps and write nothing until the end: Redraft */
  fresh: boolean;
  /** Maps this job made, by tree */
  made: Map<string, MapFile>;
  costUsd: number;
}

function chain(
  root: string,
  dir: string,
  job: Job,
  opts: { runner?: Runner; fresh?: boolean },
): Chain {
  const provider = aiProvider();
  return {
    root,
    dir,
    runner: opts.runner ?? provider.run,
    provider,
    job,
    fresh: opts.fresh ?? false,
    made: new Map(),
    costUsd: 0,
  };
}

/**
 * The map at a tree: saved, or derived from `start` by one forward read, or,
 * with no start or a patch from it past the cap, read in full at `at.rev`.
 * Written as soon as it's read, so a later read that fails keeps it.
 */
async function mapAt(
  c: Chain,
  at: { tree: string; rev: string },
  start: { tree: string; map: MapFile } | null,
  phases: { delta?: string; full: string },
): Promise<MapFile> {
  const made = c.made.get(at.tree);
  if (made) return made;
  if (!c.fresh) {
    const saved = await savedMap(c.dir, at.tree);
    if (saved) return saved;
  }
  const patch = start ? await forwardPatch(c.root, start.tree, at.tree) : null;
  let map: MapFile;
  if (start && patch === "") {
    map = { ...start.map, from: start.tree, costUsd: 0, readAt: Date.now() };
  } else if (start && patch !== null) {
    c.job.phase = phases.delta ?? phases.full;
    const read = await readMapDelta(
      c.root,
      at.rev,
      start.map.workspace,
      patch,
      c.runner,
    );
    map = {
      workspace: mergeMapDelta(start.map.workspace, read.output),
      from: start.tree,
      provider: c.provider.id,
      model: read.model ?? c.provider.model(),
      costUsd: read.costUsd,
      readAt: Date.now(),
    };
  } else {
    c.job.phase = phases.full;
    const read = await draftModel({
      root: c.root,
      rev: at.rev,
      runner: c.runner,
    });
    map = {
      workspace: read.workspace,
      from: null,
      provider: c.provider.id,
      model: read.model,
      costUsd: read.costUsd,
      readAt: Date.now(),
    };
  }
  c.costUsd += map.costUsd;
  c.made.set(at.tree, map);
  if (!c.fresh) await writeJson(mapPath(c.dir, at.tree), map);
  return map;
}

/**
 * The view's base from main's map, then its head from its base. Moves main's
 * map to the base when the base is on main and past it. Returns main's
 * pointer when this job changed it.
 */
async function readView(
  c: Chain,
  view: MapView,
  files: Files,
): Promise<Trunk | null> {
  const main = await mainTip(c.root);
  let trunk: { pointer: Trunk; map: MapFile } | null = null;
  let moved: Trunk | null = null;
  if (c.fresh && main) {
    const t = await tree(c.root, main);
    const map = await mapAt(c, { tree: t, rev: main }, null, {
      full: PHASES.main,
    });
    moved = { tree: t, commit: main };
    trunk = { pointer: moved, map };
  } else if (!c.fresh) {
    // A Redraft with no main to read again reads the base in full, rather
    // than from the old main's map it is meant to replace.
    trunk = await savedTrunk(c.dir);
  }

  let base: { tree: string; map: MapFile } | null = null;
  if (view.base && files.base) {
    const start = trunk && { tree: trunk.pointer.tree, map: trunk.map };
    const map = await mapAt(c, { tree: files.base, rev: view.base }, start, {
      delta: PHASES.base,
      full: PHASES.baseInFull,
    });
    base = { tree: files.base, map };
    // Replace a commit main no longer reaches, as after a force-push, or
    // main's map would never move again.
    const past =
      !trunk ||
      (trunk.pointer.commit !== view.base &&
        ((await isOnBranch(c.root, trunk.pointer.commit, view.base)) ||
          (!!main && !(await isOnBranch(c.root, trunk.pointer.commit, main)))));
    if (main && past && (await isOnBranch(c.root, view.base, main))) {
      moved = { tree: files.base, commit: view.base };
      if (!c.fresh) await writeJson(trunkPath(c.dir), moved);
    }
  }

  await mapAt(c, { tree: files.head, rev: view.head }, base, {
    full: PHASES.head,
  });
  return moved;
}

/**
 * Saves a redraft once every read in it succeeded: removes the repo's derived
 * maps, which may have copied an error from the old main, then writes the
 * new ones.
 */
async function saveRedraft(c: Chain, trunk: Trunk | null) {
  for (const name of await fs.readdir(c.dir).catch(() => [])) {
    const t = /^([0-9a-f]+)\.json$/.exec(name)?.[1];
    if (!t || c.made.has(t)) continue;
    const file = await readJson<MapFile>(path.join(c.dir, name));
    if (file?.from) await fs.rm(path.join(c.dir, name), { force: true });
  }
  for (const [t, map] of c.made) await writeJson(mapPath(c.dir, t), map);
  if (trunk) await writeJson(trunkPath(c.dir), trunk);
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Starts the view's read unless one is going, both ends are saved, or the
 * repo has a model of its own. Redraft reads main and the view again and
 * saves only when every read succeeds, so a failure keeps what was paid for.
 */
export async function startMapRead(
  view: MapView,
  opts: {
    redraft?: boolean;
    runner?: Runner;
    status?: () => Promise<ProviderStatus>;
  } = {},
): Promise<MapDraftStatus | MapRefusal> {
  const provider = aiProvider();
  const refusal = await mapRefusal(view.root, view.head);
  if (refusal) return refusal;
  const files = await filesFor(view);
  if (registry.jobs.has(files.key)) return mapStatus(view);
  const { job, release } = claim(files.key);

  try {
    if (!opts.redraft && (await cached(files))) {
      release();
      return mapStatus(view);
    }
    const gap = providerGap(await (opts.status ?? provider.status)());
    if (gap) {
      release();
      const status: MapDraftStatus = {
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
  if (registry.jobs.has(main)) job.behind = main;
  const c = chain(view.root, files.dir, job, {
    runner: opts.runner,
    fresh: opts.redraft,
  });
  void enqueue(async () => {
    const started = Date.now();
    try {
      // Main's read just failed with the same provider: a full read of the
      // base instead would cost as much and fail the same way.
      const mainEnded = job.behind ? registry.ended.get(job.behind) : null;
      if (mainEnded?.status === "failed") throw new Error(mainEnded.error);
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
  return mapStatus(view);
}

/** Main's tip, when main has no model of its own, none is saved, and the provider is ready. */
async function trunkToRead(
  root: string,
  dir: string,
  status?: () => Promise<ProviderStatus>,
): Promise<string | null> {
  const tip = await mainTip(root);
  if (!tip || (await savedTrunk(dir))) return null;
  if (await mapRefusal(root, tip)) return null;
  if (providerGap(await (status ?? aiProvider().status)())) return null;
  return tip;
}

/**
 * Starts reading main's map in full, when the repo has no saved main map,
 * no model of its own, and the provider is ready. True when a read was
 * queued. Not after this read failed: every repo open asks, and a read can
 * fail after it's been paid for. A view's read in full of a base on main, or
 * Redraft, makes main's map instead.
 */
export async function startMapTrunkRead(
  root: string,
  opts: { runner?: Runner; status?: () => Promise<ProviderStatus> } = {},
): Promise<boolean> {
  const dir = await mapsDir(root);
  const key = trunkKey(dir);
  if (registry.jobs.has(key) || registry.ended.get(key)?.status === "failed")
    return false;
  const { job, release } = claim(key);

  let tip: string | null = null;
  try {
    tip = await trunkToRead(root, dir, opts.status);
  } finally {
    if (!tip) release();
  }
  if (!tip) return false;

  job.phase = PHASES.waiting;
  const at = tip;
  const c = chain(root, dir, job, { runner: opts.runner });
  void enqueue(async () => {
    const started = Date.now();
    try {
      // A view's read queued ahead of this one may have saved main's map.
      if (await savedTrunk(dir)) return;
      const t = await tree(root, at);
      await mapAt(c, { tree: t, rev: at }, null, { full: PHASES.firstMain });
      await writeJson(trunkPath(dir), { tree: t, commit: at });
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
