import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as mapRoute from "../app/api/map/route";
import type { Runner } from "../lib/ai/provider";
import { setAutoRead } from "../lib/data/cache";
import { repoKey } from "../lib/git";
import { buildMap } from "../lib/map";
import { localModelFile, readModelAt, type Workspace } from "../lib/model";
import {
  mapReadSettled,
  mapStatus,
  mapTrunkReadSettled,
  PHASES,
  startMapRead,
  startMapTrunkRead,
  type MapView,
} from "../lib/models/cache";
import {
  mergeMapDelta,
  type MapDelta,
  type MapDeltaElement,
} from "../lib/models/delta";
import { serializeModel } from "../lib/models/dsl";
import type { DraftOutput } from "../lib/models/prompts";
import { homeDir } from "../lib/store";

const previousHome = process.env.BACKSTORY_HOME;
const home = mkdtempSync(path.join(os.tmpdir(), "backstory-maps-home-"));
process.env.BACKSTORY_HOME = home;
const dirs: string[] = [home];
after(() => {
  if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
  else process.env.BACKSTORY_HOME = previousHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-maps-"));
  dirs.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  /** Writes each file, or removes it for null, and commits */
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      const at = path.join(root, file);
      if (text === null) rmSync(at);
      else {
        mkdirSync(path.dirname(at), { recursive: true });
        writeFileSync(at, text);
      }
    }
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const tree = (rev: string) => git("rev-parse", `${rev}^{tree}`);
  return { root, git, commit, tree };
}

const START = {
  "README.md": "# Shop\n",
  "src/app/main.ts": "export const main = 1;\n",
  "src/sync/engine.ts": "export const sync = 1;\n",
};

/** A repo whose `main` has the shop, with `feature` checked out from it. */
function mainRepo() {
  const repo = tempRepo();
  const main = repo.commit(START, "Start the shop");
  repo.git("branch", "-M", "main");
  repo.git("checkout", "-q", "-b", "feature");
  return { ...repo, main };
}

const component = (id: string, globs: string[]) => ({
  id,
  name: id,
  description: `The ${id}`,
  technology: "TypeScript",
  globs,
});

/** What a full read answers: every app file in exactly one component. */
const SHOP: DraftOutput = {
  name: "Shop",
  description: "Sells things",
  people: [{ id: "shopper", name: "Shopper", description: "Buys things" }],
  externalSystems: [
    { id: "payments", name: "Payments", description: "Takes money" },
  ],
  system: {
    id: "shop",
    name: "Shop",
    description: "The shop",
    containers: [
      {
        id: "web",
        name: "Web",
        description: "The site",
        technology: "Node",
        components: [
          component("app", ["src/app/**"]),
          component("sync", ["src/sync/**"]),
        ],
      },
    ],
  },
  relationships: [
    { source: "shopper", destination: "app", description: "Uses" },
    { source: "app", destination: "payments", description: "Charges" },
  ],
  tests: ["test/**"],
  ignore: ["**/*.md", "**/*.txt"],
};

const delta = (d: Partial<MapDelta> = {}): MapDelta => ({
  changed: [],
  absent: [],
  arrows: [],
  absentArrows: [],
  tests: null,
  ignore: null,
  ...d,
});

const element = (
  id: string,
  globs: string[] = [],
  name = id.slice(id.lastIndexOf(".") + 1),
): MapDeltaElement => ({
  id,
  name,
  description: `The ${name}`,
  type: "component",
  parent: id.slice(0, id.lastIndexOf(".")),
  globs,
});

/**
 * A stand-in for the AI provider: `full` for a read in full, `deltas` in
 * turn for forward reads, after failing `failures` times, or on every
 * forward read with `failDeltas`. `calls` says which reads it was asked for.
 */
function recorder(
  opts: {
    full?: DraftOutput;
    deltas?: MapDelta[];
    failures?: number;
    failDeltas?: boolean;
  } = {},
) {
  const calls: ("full" | "delta" | "fix")[] = [];
  const prompts: string[] = [];
  let failures = opts.failures ?? 0;
  const deltas = [...(opts.deltas ?? [])];
  const runner: Runner = async <T>(prompt: string) => {
    const kind = prompt.includes("The patch:")
      ? "delta"
      : prompt.startsWith("You drafted")
        ? "fix"
        : "full";
    calls.push(kind);
    prompts.push(prompt);
    if (failures-- > 0 || (kind === "delta" && opts.failDeltas))
      throw new Error("Claude Code failed: blocked");
    const output =
      kind === "full"
        ? (opts.full ?? SHOP)
        : kind === "delta"
          ? (deltas.shift() ?? delta())
          : { components: [] };
    return {
      output: structuredClone(output) as T,
      costUsd: 0.1,
      model: "test-model",
    };
  };
  return { runner, calls, prompts };
}

const ready = async () => "ready" as const;

async function read(
  view: MapView,
  opts: Parameters<typeof startMapRead>[1] = {},
) {
  const started = await startMapRead(view, { status: ready, ...opts });
  await mapReadSettled(view);
  return started;
}

async function readMain(root: string, runner: Runner) {
  const started = await startMapTrunkRead(root, { runner, status: ready });
  await mapTrunkReadSettled(root);
  return started;
}

const mapsFolder = async (root: string) =>
  path.join(homeDir(), "maps", await repoKey(root));

const mapFile = async (root: string, tree: string) =>
  JSON.parse(
    readFileSync(path.join(await mapsFolder(root), `${tree}.json`), "utf8"),
  ) as { from: string | null; costUsd: number; workspace: Workspace };

const trunk = async (root: string) =>
  JSON.parse(
    readFileSync(path.join(await mapsFolder(root), "trunk.json"), "utf8"),
  ) as { tree: string; commit: string };

const states = (map: Awaited<ReturnType<typeof buildMap>>) =>
  Object.fromEntries([
    ...map.nodes.map((n) => [n.id, n.state]),
    ...map.edges.map((e) => [e.key, e.state]),
  ]);

const local = (dsl: string) => async (root: string) => {
  const file = await localModelFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, dsl);
  return file;
};
const handWritten = local(serializeModel(SHOP));
const oldDrafted = local(
  serializeModel(SHOP).replace(
    "properties {",
    'properties {\n        "backstory.drafted" "2026-10-05"',
  ),
);

test("a branch's drafted map marks the component and arrow it added and the component it removed", async () => {
  const repo = mainRepo();
  const head = repo.commit(
    { "src/billing/charge.ts": "export const charge = 1;\n" },
    "Add billing",
  );
  const removed = repo.commit({ "src/sync/engine.ts": null }, "Drop sync");

  assert.equal(await readMain(repo.root, recorder().runner), true);
  const ai = recorder({
    deltas: [
      delta({
        changed: [element("shop.web.billing", ["src/billing/**"], "Billing")],
        arrows: [
          {
            source: "shop.web.billing",
            destination: "shop.web.app",
            description: "Asks for the basket",
          },
        ],
      }),
      delta({ absent: ["shop.web.sync"] }),
    ],
  });
  await read({ root: repo.root, base: repo.main, head }, ai);
  await read({ root: repo.root, base: head, head: removed }, ai);
  assert.deepEqual(ai.calls, ["delta", "delta"]);

  const map = await buildMap(repo.root, repo.main, removed);
  assert.equal(map.source, "drafted");
  assert.equal(map.baseModel, true);
  assert.equal(map.local, false);
  const shown = states(map);
  assert.equal(shown["shop.web.billing"], "added");
  assert.equal(shown["shop.web.sync"], "removed");
  assert.equal(shown["shop.web.billing → shop.web.app"], "added");
  assert.equal(map.fileComponents["src/billing/charge.ts"], "Billing");
});

test("once main's map is saved, each branch reads only its own difference", async () => {
  const repo = mainRepo();
  const first = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  const second = repo.commit({ "src/app/total.ts": "1\n" }, "Total");

  const main = recorder();
  await readMain(repo.root, main.runner);
  assert.deepEqual(main.calls, ["full"]);
  assert.equal((await trunk(repo.root)).commit, repo.main);

  const ai = recorder();
  await read({ root: repo.root, base: first, head: second }, ai);
  assert.deepEqual(ai.calls, ["delta", "delta"]);
  const head = await mapFile(repo.root, repo.tree(second));
  assert.equal(head.from, repo.tree(first));
  assert.equal(head.costUsd, 0.1);
  assert.equal((await mapFile(repo.root, repo.tree(first))).costUsd, 0.1);
  assert.equal((await trunk(repo.root)).commit, repo.main);
  const map = await buildMap(repo.root, first, second);
  assert.equal(map.source, "drafted");

  // A second branch from the same point finds its base's map.
  repo.git("checkout", "-q", "-b", "other", first);
  const other = repo.commit({ "src/app/colour.ts": "1\n" }, "Colour");
  const next = recorder();
  await read({ root: repo.root, base: first, head: other }, next);
  assert.deepEqual(next.calls, ["delta"]);

  // A branch rebased onto a moved main: one read for main's drift, one for its head.
  repo.git("checkout", "-q", "main");
  const moved = repo.commit({ "src/sync/queue.ts": "1\n" }, "Queue");
  repo.git("checkout", "-q", "-b", "rebased");
  const rebased = repo.commit({ "src/app/pin.ts": "1\n" }, "Pin");
  const onMain = recorder();
  await read({ root: repo.root, base: moved, head: rebased }, onMain);
  assert.deepEqual(onMain.calls, ["delta", "delta"]);
  assert.equal(
    (await mapFile(repo.root, repo.tree(moved))).from,
    repo.tree(repo.main),
  );
  assert.deepEqual(await trunk(repo.root), {
    tree: repo.tree(moved),
    commit: moved,
  });
});

test("a forward read's difference merges onto its start", () => {
  const start = mergeMapDelta(
    {
      properties: { "code.tests": "test/**" },
      elements: [
        {
          id: "shop",
          name: "Shop",
          description: "",
          type: "softwareSystem",
          parent: null,
          properties: {},
        },
        {
          id: "shop.web",
          name: "Web",
          description: "",
          type: "container",
          parent: "shop",
          properties: {},
        },
        {
          id: "shop.web.app",
          name: "App",
          description: "Old",
          type: "component",
          parent: "shop.web",
          properties: { "code.globs": "src/app/**" },
        },
        {
          id: "shop.web.sync",
          name: "Sync",
          description: "",
          type: "component",
          parent: "shop.web",
          properties: {},
        },
        {
          id: "shop.web.mail",
          name: "Mail",
          description: "",
          type: "component",
          parent: "shop.web",
          properties: {},
        },
      ],
      relationships: [
        {
          source: "shop.web.app",
          destination: "shop.web.sync",
          description: "Syncs",
        },
        {
          source: "shop.web.app",
          destination: "shop.web.mail",
          description: "Mails",
        },
        {
          source: "shop.web.mail",
          destination: "shop.web.app",
          description: "Old",
        },
        {
          source: "shop.web.mail",
          destination: "shop.web.app",
          description: "Older",
        },
      ],
    },
    delta({
      changed: [
        {
          ...element("shop.web.app", ["src/app/**", "src/my file.ts"]),
          name: "App",
          description: "New",
        },
        element("shop.web.billing", ["src/billing/**"]),
        element("shop.gone.orphan"),
      ],
      absent: ["shop.web.sync"],
      arrows: [
        {
          source: "shop.web.mail",
          destination: "shop.web.app",
          description: "Replies",
        },
        {
          source: "shop.web.billing",
          destination: "shop.web.app",
          description: "Bills",
        },
        {
          source: "shop.web.billing",
          destination: "nowhere",
          description: "Lost",
        },
        {
          source: "shop.web.billing",
          destination: "shop.web",
          description: "Parent",
        },
      ],
      absentArrows: [{ source: "shop.web.app", destination: "shop.web.mail" }],
    }),
  );

  assert.deepEqual(start.properties, { "code.tests": "test/**" });
  assert.deepEqual(
    start.elements.map((e) => [
      e.id,
      e.description,
      e.properties["code.globs"],
    ]),
    [
      ["shop", "", undefined],
      ["shop.web", "", undefined],
      ["shop.web.app", "New", "src/app/** src/my?file.ts"],
      ["shop.web.mail", "", undefined],
      ["shop.web.billing", "The billing", "src/billing/**"],
    ],
  );
  assert.deepEqual(
    start.relationships.map(
      (r) => `${r.source} → ${r.destination}: ${r.description}`,
    ),
    [
      "shop.web.mail → shop.web.app: Replies",
      "shop.web.billing → shop.web.app: Bills",
    ],
  );
});

test("a forward read's tests and ignore replace the start's globs, and null keeps them", () => {
  const start: Workspace = {
    properties: { "code.tests": "test/**", "code.ignore": "**/*.md" },
    elements: [],
    relationships: [],
  };
  assert.deepEqual(mergeMapDelta(start, delta()).properties, start.properties);
  assert.deepEqual(
    mergeMapDelta(start, delta({ tests: ["test/**", "e2e/**"], ignore: [] }))
      .properties,
    { "code.tests": "test/** e2e/**" },
  );
});

test("a forward read's elements that sit inside themselves are dropped", () => {
  const merged = mergeMapDelta(
    { properties: {}, elements: [], relationships: [] },
    delta({
      changed: [
        { ...element("shop"), parent: "" },
        { ...element("shop.web"), parent: "shop.web" },
        { ...element("shop.a"), parent: "shop.b" },
        { ...element("shop.b"), parent: "shop.a" },
        { ...element("shop.c"), parent: "shop.a" },
        element("shop.d"),
      ],
      arrows: [
        { source: "shop.d", destination: "shop.a", description: "Loops" },
      ],
    }),
  );
  assert.deepEqual(
    merged.elements.map((e) => e.id),
    ["shop", "shop.d"],
  );
  assert.deepEqual(merged.relationships, []);
});

test("an empty change reads nothing past its base, and its map is its base's", async () => {
  const repo = mainRepo();
  repo.git("commit", "--allow-empty", "-qm", "Nothing");
  const head = repo.git("rev-parse", "HEAD");
  const ai = recorder();
  await read({ root: repo.root, base: repo.main, head }, ai);
  assert.deepEqual(ai.calls, ["full"]);
  assert.equal(
    (await mapStatus({ root: repo.root, base: repo.main, head })).status,
    "done",
  );
  const map = await buildMap(repo.root, repo.main, head);
  assert.equal(map.source, "drafted");
  assert.equal(map.baseModel, true);
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(map.whole?.nodes.map((n) => n.id).sort(), [
    "payments",
    "shop.web",
    "shopper",
  ]);
});

test("a patch past the cap reads that commit in full, at that commit, and it becomes main's map", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  repo.git("checkout", "-q", "main");
  const big = repo.commit(
    { "big.txt": `${"x".repeat(99)}\n`.repeat(5000) },
    "Add a big file",
  );
  repo.git("checkout", "-q", "-b", "later");
  const head = repo.commit({ "src/app/later.ts": "1\n" }, "Later");

  const ai = recorder();
  await read({ root: repo.root, base: big, head }, ai);
  assert.deepEqual(ai.calls, ["full", "delta"]);
  assert.match(ai.prompts[0], new RegExp(`at commit ${big.slice(0, 7)}`));
  assert.equal((await mapFile(repo.root, repo.tree(big))).from, null);
  assert.equal((await trunk(repo.root)).commit, big);
});

test("a failed read says why, caches nothing, and Try again reads only what's missing", async () => {
  const repo = mainRepo();
  const head = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  const view = { root: repo.root, base: repo.main, head };

  const failing = recorder({ failDeltas: true });
  await read(view, failing);
  assert.deepEqual(failing.calls, ["full", "delta"]);
  assert.deepEqual(await mapStatus(view), {
    status: "failed",
    error: "Claude Code failed: blocked",
  });
  assert.equal(await readModelAt(repo.root, head), null);
  assert.ok((await readModelAt(repo.root, repo.main))?.model);

  const again = recorder();
  await read(view, again);
  assert.deepEqual(again.calls, ["delta"]);
  assert.equal((await mapStatus(view)).status, "done");
});

test("a provider that isn't installed, or is logged out, says so and reads nothing", async () => {
  const repo = mainRepo();
  const head = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  const view = { root: repo.root, base: repo.main, head };
  for (const [status, reason] of [
    ["missing", "no-claude"],
    ["logged-out", "logged-out"],
  ] as const) {
    const ai = recorder();
    const started = await startMapRead(view, {
      runner: ai.runner,
      status: async () => status,
    });
    assert.deepEqual(started, {
      status: "unavailable",
      provider: "Claude Code",
      reason,
    });
    assert.deepEqual(await mapStatus(view), started);
    assert.deepEqual(ai.calls, []);
  }
  assert.equal(existsSync(await mapsFolder(repo.root)), false);
});

const post = (query: string) =>
  mapRoute.POST(
    new Request(`http://localhost/api/map?${query}`, { method: "POST" }),
  );

test("a repo that commits a model, or has a hand-written one, is never drafted, and the route refuses", async () => {
  const committed = tempRepo();
  committed.commit(
    { ...START, "architecture/workspace.dsl": serializeModel(SHOP) },
    "Commit a model",
  );
  committed.git("branch", "-M", "main");
  const withLocal = mainRepo();
  const file = await handWritten(withLocal.root);
  const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };

  for (const [repo, reason] of [
    [committed, "committed"],
    [withLocal, "local"],
  ] as [ReturnType<typeof tempRepo>, "committed" | "local"][]) {
    const head = repo.git("rev-parse", "HEAD");
    const ai = recorder();
    assert.deepEqual(
      await startMapRead(
        { root: repo.root, base: null, head },
        { runner: ai.runner, status: ready },
      ),
      { status: "refused", reason },
    );
    assert.equal(await readMain(repo.root, ai.runner), false);
    assert.deepEqual(ai.calls, []);
    const response = await post(
      `repo=${encodeURIComponent(repo.root)}&rev=${head}`,
    );
    assert.equal(response.status, 409);
  }

  const read = await readModelAt(withLocal.root, withLocal.main);
  assert.equal(read?.source, "local");
  assert.equal(read?.file, file);
  const map = await buildMap(withLocal.root, null, withLocal.main);
  assert.equal(map.source, "local");
  assert.equal(map.local, true);
  assert.equal(map.draft, undefined);
  assert.deepEqual(readFileSync(file), before.bytes);
  assert.equal(statSync(file).mtimeMs, before.mtime);
});

test("the old drafted local model is skipped and left untouched, so the repo's map is drafted", async () => {
  const repo = mainRepo();
  const file = await oldDrafted(repo.root);
  const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
  assert.equal(await readModelAt(repo.root, repo.main), null);
  const none = await buildMap(repo.root, null, repo.main);
  assert.equal(none.status, "none");
  assert.equal(none.handFile, file);
  assert.equal(none.draft?.status, "idle");

  assert.equal(await readMain(repo.root, recorder().runner), true);
  const read = await readModelAt(repo.root, repo.main);
  assert.equal(read?.source, "drafted");
  assert.equal(read?.file, null);
  assert.deepEqual(readFileSync(file), before.bytes);
  assert.equal(statSync(file).mtimeMs, before.mtime);
});

test("readModelAt returns the drafted map saved for a tree, so flows see it", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  const read = await readModelAt(repo.root, repo.main);
  assert.equal(read?.source, "drafted");
  assert.deepEqual(read?.model?.match("src/app/main.ts"), ["shop.web.app"]);
  assert.equal(read?.model?.isIgnored("README.md"), true);
  // A reworded commit has the same tree, so the same map.
  repo.git("checkout", "-q", "main");
  repo.git("commit", "-q", "--amend", "-m", "Reworded");
  assert.equal((await readModelAt(repo.root, "HEAD"))?.source, "drafted");
});

test("main's read writes trunk.json, and isn't started again after it fails", async () => {
  const repo = mainRepo();
  const failing = recorder({ failures: Infinity });
  assert.equal(await readMain(repo.root, failing.runner), true);
  assert.equal(await readMain(repo.root, failing.runner), false);
  assert.deepEqual(failing.calls, ["full"]);
  assert.equal(
    existsSync(path.join(await mapsFolder(repo.root), "trunk.json")),
    false,
  );

  const other = mainRepo();
  assert.equal(await readMain(other.root, recorder().runner), true);
  assert.equal((await trunk(other.root)).commit, other.main);
  assert.equal(await readMain(other.root, recorder().runner), false);
});

test("main's read starts again when the map trunk.json points at is gone", async () => {
  const repo = mainRepo();
  assert.equal(await readMain(repo.root, recorder().runner), true);
  rmSync(
    path.join(
      await mapsFolder(repo.root),
      `${(await trunk(repo.root)).tree}.json`,
    ),
  );
  const ai = recorder();
  assert.equal(await readMain(repo.root, ai.runner), true);
  assert.deepEqual(ai.calls, ["full"]);
  assert.equal((await mapFile(repo.root, repo.tree(repo.main))).from, null);
});

test("main's read doesn't start without a ready provider", async () => {
  const repo = mainRepo();
  const ai = recorder();
  assert.equal(
    await startMapTrunkRead(repo.root, {
      runner: ai.runner,
      status: async () => "logged-out",
    }),
    false,
  );
  assert.deepEqual(ai.calls, []);
});

test("a base on main past main's map is one forward read, and main's map moves to it", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  repo.git("checkout", "-q", "main");
  const moved = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  repo.git("checkout", "-q", "-b", "later");
  const head = repo.commit({ "src/app/total.ts": "1\n" }, "Total");

  const ai = recorder();
  await read({ root: repo.root, base: moved, head }, ai);
  assert.deepEqual(ai.calls, ["delta", "delta"]);
  assert.deepEqual(await trunk(repo.root), {
    tree: repo.tree(moved),
    commit: moved,
  });
});

test("after main is rewritten, a base on main moves main's map", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  repo.git("checkout", "-q", "main");
  repo.git("commit", "-q", "--amend", "-m", "Start, reworded");
  const later = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  repo.git("checkout", "-q", "-b", "after");
  const head = repo.commit({ "src/app/total.ts": "1\n" }, "Total");

  await read({ root: repo.root, base: later, head }, recorder());
  assert.equal((await trunk(repo.root)).commit, later);
});

test("a view queued behind main's read shows main's phase, and fails with it", async () => {
  const repo = mainRepo();
  const head = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  const view = { root: repo.root, base: repo.main, head };

  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered = () => {};
  const reading = new Promise<void>((resolve) => (entered = resolve));
  const failing = recorder({ failures: Infinity });
  const gated: Runner = async <T>(
    prompt: string,
    schema: object,
    cwd: string,
  ) => {
    entered();
    await gate;
    return failing.runner<T>(prompt, schema, cwd);
  };

  assert.equal(
    await startMapTrunkRead(repo.root, { runner: gated, status: ready }),
    true,
  );
  await startMapRead(view, { runner: failing.runner, status: ready });
  await reading;
  const waiting = await mapStatus(view);
  assert.equal(waiting.status, "running");
  assert.equal(waiting.status === "running" && waiting.phase, PHASES.firstMain);

  open();
  await mapTrunkReadSettled(repo.root);
  await mapReadSettled(view);
  assert.deepEqual(failing.calls, ["full"]);
  assert.deepEqual(await mapStatus(view), {
    status: "failed",
    error: "Claude Code failed: blocked",
  });
  const dir = await mapsFolder(repo.root);
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
});

test("Redraft reads main in full again and removes derived maps, and a failed Redraft keeps what was saved", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  const feature = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  repo.git("checkout", "-q", "-b", "other", repo.main);
  const other = repo.commit({ "src/app/colour.ts": "1\n" }, "Colour");
  const otherView = { root: repo.root, base: repo.main, head: other };
  await read(otherView, recorder());
  const featureView = { root: repo.root, base: repo.main, head: feature };
  await read(featureView, recorder());

  const failed = recorder({ failDeltas: true });
  await read(featureView, { runner: failed.runner, redraft: true });
  assert.deepEqual(failed.calls, ["full", "delta"]);
  assert.equal((await mapStatus(featureView)).status, "failed");
  assert.ok(
    existsSync(
      path.join(await mapsFolder(repo.root), `${repo.tree(other)}.json`),
    ),
  );

  const renamed = structuredClone(SHOP);
  renamed.system.name = "Shop, redrafted";
  const redraft = recorder({ full: renamed });
  await read(featureView, { runner: redraft.runner, redraft: true });
  assert.deepEqual(redraft.calls, ["full", "delta"]);
  assert.equal(
    existsSync(
      path.join(await mapsFolder(repo.root), `${repo.tree(other)}.json`),
    ),
    false,
  );
  assert.equal(
    (await readModelAt(repo.root, repo.main))?.model?.elements.get("shop")
      ?.name,
    "Shop, redrafted",
  );

  const derived = recorder();
  await read(otherView, derived);
  assert.deepEqual(derived.calls, ["delta"]);
});

test("with no default branch, Redraft reads the base in full, not from the old main's map", async () => {
  const repo = mainRepo();
  await readMain(repo.root, recorder().runner);
  const feature = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  const view = { root: repo.root, base: repo.main, head: feature };
  await read(view, recorder());
  repo.git("branch", "-M", "main", "no-default-here");

  const redraft = recorder();
  await read(view, { runner: redraft.runner, redraft: true });
  assert.deepEqual(redraft.calls, ["full", "delta"]);
});

test("the idle status says whether reading is on, and with the repo turned off main's read doesn't start", async () => {
  const repo = mainRepo();
  const head = repo.commit({ "src/app/basket.ts": "1\n" }, "Basket");
  assert.deepEqual((await buildMap(repo.root, repo.main, head)).draft, {
    status: "idle",
    provider: "Claude Code",
    auto: true,
  });

  await setAutoRead(repo.root, false);
  const map = await buildMap(repo.root, repo.main, head);
  assert.equal(map.status, "none");
  assert.deepEqual(map.draft, {
    status: "idle",
    provider: "Claude Code",
    auto: false,
  });
  assert.equal(map.auto, false);
  const trunkPost = () => post(`repo=${encodeURIComponent(repo.root)}&trunk=1`);
  assert.deepEqual(await (await trunkPost()).json(), { started: false });
  assert.equal(existsSync(await mapsFolder(repo.root)), false);
});

test("reading main's map reads no branch's view, so a view nobody opens is never read", async () => {
  const repo = mainRepo();
  const views = ["one", "two", "three"].map((name) => {
    repo.git("checkout", "-q", "-b", name, repo.main);
    return {
      root: repo.root,
      base: repo.main,
      head: repo.commit({ [`src/app/${name}.ts`]: "1\n" }, name),
    };
  });

  const ai = recorder();
  assert.equal(await readMain(repo.root, ai.runner), true);
  assert.deepEqual(ai.calls, ["full"]);
  for (const view of views)
    assert.equal((await mapStatus(view)).status, "idle");
});
