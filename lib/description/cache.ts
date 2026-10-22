import { promises as fs } from "node:fs";
import path from "node:path";

import {
  aiProvider,
  providerGap,
  type ProviderStatus,
  type Runner,
} from "../ai/provider";
import {
  autoRead,
  dataReadSettled,
  providerName,
  startDataRead,
} from "../data/cache";
import { dataSteer, readDataModel, steerError } from "../data/readers";
import { buildData } from "../data/build";
import { MAX_PATCH_BYTES } from "../data/drafted";
import { git, gitLine } from "../exec";
import { withSnapshot } from "../flows/generate";
import { getRangePatch, repoKey } from "../git";
import { buildMap } from "../map";
import { readModelAt } from "../model";
import { mapReadSettled, startMapRead } from "../models/cache";
import { homeDir } from "../store";
import {
  descriptionPrompt,
  descriptionSchema,
  LOOK_FIRST_MAX,
  type DescriptionInputs,
  type DescriptionOutput,
} from "./prompt";
import type { ChangeDescription, DescriptionStatus } from "./types";

/**
 * Change descriptions and the reads that make them: what a view's change
 * does, why, and where to look first, from its patch, commit messages and PR.
 *
 * One file per view, `~/.backstory/descriptions/<repo>/<base>..<head>.json`,
 * keyed by trees, so a rebase or a reworded commit that leaves the files as
 * they were reads from the cache. A cache, safe to delete; after a prompt
 * change, delete it.
 *
 * Reads run one at a time on a queue of their own. Kept on globalThis, as
 * `lib/flows/cache.ts` keeps its runs, because Next may load this module once
 * per route bundle.
 */

export interface DescriptionView {
  root: string;
  /** Null for a root commit */
  base: string | null;
  head: string;
}

/** The PR's title and body, for the prompt */
export type PrText = { title: string; body: string } | null;

interface DescriptionFile {
  description: ChangeDescription;
  /** The AI provider's id */
  provider: string;
  model: string | null;
  readAt: number;
}

interface Job {
  startedAt: number;
  settled: Promise<void>;
}

interface Registry {
  jobs: Map<string, Job>;
  /** How the last read for a view failed or couldn't start, until the next one starts */
  ended: Map<
    string,
    Extract<DescriptionStatus, { status: "failed" | "unavailable" }>
  >;
  queue: Promise<unknown>;
}

const g = globalThis as { __backstoryDescriptions?: Registry };
const registry: Registry = (g.__backstoryDescriptions ??= {
  jobs: new Map(),
  ended: new Map(),
  queue: Promise.resolve(),
});

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const tree = async (root: string, rev: string) => {
  const t = await gitLine(root, ["rev-parse", "--verify", `${rev}^{tree}`]);
  if (!t) throw new Error(`No commit ${rev.slice(0, 7)} to describe.`);
  return t;
};

async function fileFor(view: DescriptionView): Promise<string> {
  const dir = path.join(homeDir(), "descriptions", await repoKey(view.root));
  const head = await tree(view.root, view.head);
  const base = view.base ? await tree(view.root, view.base) : "root";
  return path.join(dir, `${base}..${head}.json`);
}

async function readCache(file: string): Promise<DescriptionFile | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as DescriptionFile;
  } catch {
    return null;
  }
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
async function writeCache(file: string, value: DescriptionFile) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, JSON.stringify(value, null, 1), "utf8");
  await fs.rename(temp, file);
}

export async function descriptionStatus(
  view: DescriptionView,
  status?: () => Promise<ProviderStatus>,
): Promise<DescriptionStatus> {
  const file = await fileFor(view);
  const job = registry.jobs.get(file);
  if (job) return { status: "running", startedAt: job.startedAt };
  let ended = registry.ended.get(file);
  // Ask the provider again while it was missing or signed out, so installing
  // or signing in brings the read back without a restart.
  if (ended?.status === "unavailable") {
    const reason = providerGap(await (status ?? aiProvider().status)());
    if (reason) {
      ended = { ...ended, reason };
      registry.ended.set(file, ended);
    } else {
      registry.ended.delete(file);
      ended = undefined;
    }
  }
  const cached = await readCache(file);
  // A Describe again that failed or couldn't start keeps showing the
  // description it would have replaced, with why.
  if (cached)
    return {
      status: "done",
      // A description cached before it named components has none.
      description: {
        ...cached.description,
        components: cached.description.components ?? [],
      },
      provider: providerName(cached.provider),
      model: cached.model,
      readAt: cached.readAt,
      auto: await autoRead(view.root),
      ...(ended?.status === "failed" && { error: ended.error }),
      ...(ended?.status === "unavailable" && { gap: ended.reason }),
    };
  if (ended) return ended;
  return {
    status: "idle",
    provider: aiProvider().name,
    auto: await autoRead(view.root),
  };
}

/** The current read's end, for tests: nothing waits on a read otherwise. */
export async function descriptionReadSettled(
  view: DescriptionView,
): Promise<void> {
  await registry.jobs.get(await fileFor(view))?.settled;
}

/** The patch, or past the cap the patch cut at it with a `--stat` of the whole. */
async function patchFor(view: DescriptionView) {
  const from = view.base ?? EMPTY_TREE;
  const patch = await getRangePatch(view.root, from, view.head);
  const bytes = Buffer.from(patch);
  if (bytes.byteLength <= MAX_PATCH_BYTES) return { patch, stat: null };
  // Widen the stat past git's 80 columns, which shorten long paths to
  // `.../tail` that the provider can't open.
  const { stdout: stat } = await git(view.root, [
    "diff",
    "--stat=10000",
    "--no-color",
    from,
    view.head,
  ]);
  // Cut at the last line end before the cap, so the provider never sees half
  // a line or a split UTF-8 character.
  const end = bytes.lastIndexOf(0x0a, MAX_PATCH_BYTES - 1) + 1;
  return {
    patch: bytes.subarray(0, end || MAX_PATCH_BYTES).toString("utf8"),
    stat: stat.trimEnd(),
  };
}

/** Subject and body of every commit in the view, oldest first. */
async function messagesFor(view: DescriptionView) {
  const range = view.base ? `${view.base}..${view.head}` : view.head;
  const { stdout } = await git(view.root, [
    "log",
    "--reverse",
    "--format=%s%n%n%b",
    range,
  ]);
  return stdout;
}

type Reads = { runner?: Runner; status?: () => Promise<ProviderStatus> };

/**
 * Waits for this view's map and data model reads, so the names offered come
 * from this commit's rather than none while they're still being read. Starts
 * them when the repo reads automatically, since the page may ask for the
 * description before it asks for them. A read that fails leaves its names
 * out.
 */
async function namesReady(view: DescriptionView, opts: Reads) {
  const auto = await autoRead(view.root);
  await Promise.all([mapReady(view, auto, opts), dataReady(view, auto, opts)]);
}

async function mapReady(view: DescriptionView, auto: boolean, opts: Reads) {
  if (auto) await startMapRead(view, opts).catch(() => null);
  await mapReadSettled(view);
}

/** Skips a repo whose data model a reader finds, as `/api/data` does. */
async function dataReady(view: DescriptionView, auto: boolean, opts: Reads) {
  const steer = dataSteer(
    (await readModelAt(view.root, view.head))?.model?.properties,
  );
  if (steerError(steer) || (await readDataModel(view.root, view.head, steer)))
    return;
  const data = { ...view, files: steer.files };
  if (auto) await startDataRead(data, opts).catch(() => null);
  await dataReadSettled(data);
}

/** The names the prompt offers: the components and entities the change touches. */
async function namesFor(view: DescriptionView) {
  const [map, data] = await Promise.all([
    buildMap(view.root, view.base, view.head).catch(() => null),
    buildData(view.root, view.base, view.head).catch(() => null),
  ]);
  const hasMap = !!map && map.status === "ok";
  return {
    components: hasMap
      ? map.nodes
          .filter((n) => !n.group && n.state !== "neighbour")
          .map((n) => n.name)
      : null,
    entities: (data?.entities ?? [])
      .filter((e) => e.state !== "same")
      .map((e) => e.name),
  };
}

async function gather(view: DescriptionView, pr: () => Promise<PrText>) {
  const [patch, messages, names, prText] = await Promise.all([
    patchFor(view),
    messagesFor(view),
    namesFor(view),
    pr().catch(() => null),
  ]);
  const inputs: DescriptionInputs = {
    ...patch,
    messages,
    pr: prText,
    ...names,
  };
  return inputs;
}

/** Drops blank names, and keeps each name once. */
const eachOnce = <T extends { name: string }>(items: T[]) =>
  items.filter(
    (l, i, all) => l.name && all.findIndex((o) => o.name === l.name) === i,
  );

/**
 * The answer, tidied: a blank why is none, lookFirst is cut to its limit, and
 * each name, in lookFirst and components, is kept once.
 */
export function toDescription(output: DescriptionOutput): ChangeDescription {
  const why = output.why?.trim();
  const lookFirst = eachOnce(
    output.lookFirst.map((l) => ({
      name: l.name.trim(),
      reason: l.reason.trim(),
    })),
  ).slice(0, LOOK_FIRST_MAX);
  const components = eachOnce(
    (output.components ?? []).map((c) => ({
      name: c.name.trim(),
      sentence: c.sentence.trim(),
    })),
  ).filter((c) => c.sentence);
  return {
    what: output.what.trim(),
    why: why ? why : null,
    lookFirst,
    components,
  };
}

function enqueue(fn: () => Promise<void>) {
  const next = registry.queue.then(fn, fn);
  registry.queue = next.catch(() => {});
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Starts the view's read unless one is going or its description is cached.
 * `redraft` reads it again, replacing the cached one only when the read
 * succeeds.
 */
export async function startDescription(
  view: DescriptionView,
  opts: {
    redraft?: boolean;
    pr?: () => Promise<PrText>;
    runner?: Runner;
    status?: () => Promise<ProviderStatus>;
  } = {},
): Promise<DescriptionStatus> {
  const provider = aiProvider();
  const file = await fileFor(view);
  if (registry.jobs.has(file)) return descriptionStatus(view);
  // Registered before any check that waits, so a second request meanwhile
  // sees this job rather than starting another.
  let settle = () => {};
  const job: Job = {
    startedAt: Date.now(),
    settled: new Promise((resolve) => (settle = resolve)),
  };
  registry.jobs.set(file, job);
  const release = () => {
    registry.jobs.delete(file);
    settle();
  };

  try {
    if (!opts.redraft && (await readCache(file))) {
      registry.ended.delete(file);
      release();
      return descriptionStatus(view);
    }
    const gap = providerGap(await (opts.status ?? provider.status)());
    if (gap) {
      release();
      const status = {
        status: "unavailable",
        provider: provider.name,
        reason: gap,
      } as const;
      registry.ended.set(file, status);
      return status;
    }
  } catch (err) {
    release();
    throw err;
  }

  registry.ended.delete(file);
  const runner = opts.runner ?? provider.run;
  // Joins the queue only once the names are ready, so a view whose map is
  // still being read doesn't hold up the descriptions behind it.
  void namesReady(view, opts)
    .catch(() => {})
    .then(() =>
      enqueue(async () => {
        try {
          const inputs = await gather(view, opts.pr ?? (async () => null));
          const read = await withSnapshot(view.root, view.head, (dir) =>
            runner<DescriptionOutput>(
              descriptionPrompt(inputs),
              descriptionSchema(),
              dir,
            ),
          );
          await writeCache(file, {
            description: toDescription(read.output),
            provider: provider.id,
            model: read.model ?? provider.model(),
            readAt: Date.now(),
          });
        } catch (err) {
          registry.ended.set(file, { status: "failed", error: message(err) });
        } finally {
          release();
        }
      }),
    );
  return descriptionStatus(view);
}
