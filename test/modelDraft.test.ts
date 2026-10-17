import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import * as mapRoute from "../app/api/map/route";
import type { Runner } from "../lib/ai/provider";
import { readDsl } from "../lib/dsl";
import type { MapResponse } from "../lib/map";
import {
  buildModel,
  isAppCode,
  localModelFile,
  readModelAt,
} from "../lib/model";
import { startMapRead } from "../lib/models/cache";
import { draftModel } from "../lib/models/draft";
import { serializeModel } from "../lib/models/dsl";
import { checkGlobs } from "../lib/models/globs";
import type { DraftOutput, GlobFixOutput } from "../lib/models/prompts";

const dirs: string[] = [];
const previousHome = process.env.BACKSTORY_HOME;
const home = mkdtempSync(path.join(os.tmpdir(), "backstory-home-"));
dirs.push(home);
process.env.BACKSTORY_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
  else process.env.BACKSTORY_HOME = previousHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "README.md": "# Shop\n",
  "package-lock.json": "{}\n",
  "src/app/main.ts": "export const main = 1;\n",
  "src/app/util.ts": "export const util = 1;\n",
  "src/sync/engine.ts": "export const sync = 1;\n",
  "test/main.test.ts": "it('runs', () => {});\n",
};

function gitRepo(extra: Record<string, string> = {}, at?: string) {
  const dir =
    at ?? mkdtempSync(path.join(os.tmpdir(), "backstory-draft-test-"));
  if (at) mkdirSync(dir);
  else dirs.push(dir);
  const sh = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  sh("init", "-q");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "Test");
  for (const [file, text] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  sh("add", ".");
  sh("commit", "-qm", "init");
  return { dir, sh };
}

/** A repo in its own temp parent, so two can share a folder name. */
function namedRepo(name: string, extra: Record<string, string> = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "backstory-parent-"));
  dirs.push(parent);
  return gitRepo(extra, path.join(parent, name));
}

const component = (id: string, globs: string[]) => ({
  id,
  name: id,
  description: `The ${id}`,
  technology: "TypeScript",
  globs,
});

type Components = DraftOutput["system"]["containers"][0]["components"];

function answer(components: Components) {
  return {
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
          components,
        },
      ],
    },
    relationships: [
      { source: "shopper", destination: "app", description: "Uses" },
      { source: "app", destination: "payments", description: "Charges" },
    ],
    tests: ["test/**"],
    ignore: ["**/*.md", "package-lock.json"],
  } satisfies DraftOutput;
}

const CLEAN = answer([
  component("app", ["src/app/**"]),
  component("sync", ["src/sync/**"]),
]);
/** Leaves the sync engine out, and claims util.ts twice. */
const MESSY = answer([
  component("app", ["src/app/**"]),
  component("util", ["src/app/util.ts"]),
  component("sync", []),
]);

function recorded(answers: (object | Error)[]) {
  const prompts: string[] = [];
  const runner: Runner = async <T>(prompt: string) => {
    prompts.push(prompt);
    const next = answers.shift();
    if (!next) throw new Error("no more recorded answers");
    if (next instanceof Error) throw next;
    return {
      output: structuredClone(next) as T,
      costUsd: 0.5,
      model: "claude-test",
    };
  };
  return { runner, prompts };
}

const ready = async () => "ready" as const;

test("a full draft reads the commit it's given, places every app file once, and writes nothing", async () => {
  const repo = gitRepo();
  const first = repo.sh("rev-parse", "HEAD");
  writeFileSync(path.join(repo.dir, "src/app/later.ts"), "1\n");
  repo.sh("add", ".");
  repo.sh("commit", "-qm", "later");
  const { runner, prompts } = recorded([CLEAN]);
  const result = await draftModel({ root: repo.dir, rev: first, runner });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], new RegExp(`at commit ${first.slice(0, 7)}`));
  assert.equal(result.costUsd, 0.5);
  assert.equal(result.model, "claude-test");
  const model = buildModel(result.workspace);
  const appFiles = Object.keys(FILES).filter((f) => isAppCode(model, f));
  assert.deepEqual(appFiles, [
    "src/app/main.ts",
    "src/app/util.ts",
    "src/sync/engine.ts",
  ]);
  for (const f of appFiles) assert.equal(model.match(f).length, 1, f);
  assert.equal(result.workspace.properties["backstory.drafted"], undefined);

  assert.equal(repo.sh("status", "--porcelain", "--ignored"), "");
  assert.equal(existsSync(path.join(home, "models")), false);
});

test("a draft reads back as it was written, whatever its strings and ids", () => {
  const awkward: DraftOutput = {
    name: "Shop",
    description: 'Say "hi"',
    people: [{ id: "user", name: "back\\slash", description: "trailing\\" }],
    externalSystems: [
      { id: "user", name: "# hash", description: "// slashes" },
    ],
    system: {
      id: "shop",
      name: "Shop",
      description: "multi\nline\r\n  text",
      containers: [
        {
          id: "web-app",
          name: "Web",
          description: 'ends in \\"',
          technology: "Node",
          components: [
            component("api", ["src/api/**", "src/my file.ts"]),
            component("API", ["src/API/**"]),
            component("", []),
          ],
        },
      ],
    },
    relationships: [
      { source: "api", destination: "API", description: "Calls" },
      { source: "api", destination: "missing", description: "Lost" },
      { source: "shop", destination: "api", description: "Parent" },
      { source: "api", destination: "API", description: "Calls" },
    ],
    tests: ["test/**"],
    ignore: ["**/*.md"],
  };
  const ws = readDsl(serializeModel(awkward));

  assert.deepEqual(ws.properties, {
    "code.tests": "test/**",
    "code.ignore": "**/*.md",
  });
  assert.deepEqual(
    ws.elements.map((e) => [e.id, e.type, e.parent, e.name, e.description]),
    [
      ["user", "person", null, "back\\slash", "trailing"],
      ["user_2", "softwareSystem", null, "# hash", "// slashes"],
      ["shop", "softwareSystem", null, "Shop", "multi line text"],
      ["shop.web_app", "container", "shop", "Web", 'ends in \\"'],
      ["shop.web_app.api", "component", "shop.web_app", "api", "The api"],
      ["shop.web_app.API_2", "component", "shop.web_app", "API", "The API"],
      // A nameless element is named by its id, so the DSL has a name to read.
      [
        "shop.web_app.component",
        "component",
        "shop.web_app",
        "component",
        "The",
      ],
    ],
  );
  assert.equal(
    ws.elements.find((e) => e.id === "shop.web_app.api")?.properties[
      "code.globs"
    ],
    "src/api/** src/my?file.ts",
  );
  assert.deepEqual(ws.relationships, [
    {
      source: "shop.web_app.api",
      destination: "shop.web_app.API_2",
      description: "Calls",
    },
  ]);
});

test("the glob check finds files no component has, and files two have", () => {
  const files = Object.keys(FILES);
  assert.deepEqual(checkGlobs(serializeModel(CLEAN), files), {
    unmatched: [],
    ambiguous: [],
  });
  assert.deepEqual(checkGlobs(serializeModel(MESSY), files), {
    unmatched: ["src/sync/engine.ts"],
    ambiguous: [
      {
        file: "src/app/util.ts",
        ids: ["shop.web.app", "shop.web.util"],
      },
    ],
  });
});

test("files the first answer misplaces get one more call, whose globs are used", async () => {
  const repo = gitRepo();
  const fix: GlobFixOutput = {
    components: [
      { id: "shop.web.app", globs: ["src/app/main.ts"] },
      { id: "shop.web.sync", globs: ["src/sync/**"] },
    ],
  };
  const { runner, prompts } = recorded([MESSY, fix]);
  const result = await draftModel({ root: repo.dir, rev: "HEAD", runner });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /src\/sync\/engine\.ts/);
  assert.match(
    prompts[1],
    /src\/app\/util\.ts ← shop\.web\.app, shop\.web\.util/,
  );
  assert.ok(!prompts[1].includes("main.test.ts"));
  assert.equal(result.costUsd, 1);
  const model = buildModel(result.workspace);
  assert.deepEqual(model.match("src/sync/engine.ts"), ["shop.web.sync"]);
  assert.deepEqual(model.match("src/app/util.ts"), ["shop.web.util"]);
});

test("a failed run says why", async () => {
  const repo = gitRepo();
  const { runner } = recorded([new Error("Claude Code failed: out of credit")]);
  await assert.rejects(draftModel({ root: repo.dir, rev: "HEAD", runner }), {
    message: "Claude Code failed: out of credit",
  });
});

/** Writes a hand-written local model for the repo, and returns its path. */
async function handWrite(root: string, output: DraftOutput = CLEAN) {
  const file = await localModelFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeModel(output));
  return file;
}

const systemName = async (root: string) =>
  (await readModelAt(root, "HEAD"))?.model?.elements.get("shop")?.name;

test("two repos with the same folder name each have their own hand-written model", async () => {
  const one = namedRepo("api");
  const two = namedRepo("api", { "src/app/extra.ts": "export const x = 1;\n" });
  const renamed = structuredClone(CLEAN);
  renamed.system.name = "Other shop";
  const oneFile = await handWrite(one.dir);
  const twoFile = await handWrite(two.dir, renamed);

  assert.notEqual(oneFile, twoFile);
  assert.equal(await systemName(one.dir), "Shop");
  assert.equal(await systemName(two.dir), "Other shop");
});

test("every worktree of a repo reads the same hand-written model", async () => {
  const repo = gitRepo();
  const parent = mkdtempSync(path.join(os.tmpdir(), "backstory-worktree-"));
  dirs.push(parent);
  const worktree = path.join(parent, "second");
  repo.sh("worktree", "add", "-q", "--detach", worktree);
  const file = await handWrite(repo.dir);

  assert.equal(await localModelFile(worktree), file);
  const read = await readModelAt(worktree, "HEAD");
  assert.ok(read?.model, read?.error ?? "no model");
  assert.equal(read.source, "local");
  assert.equal(read.file, file);
});

test("a model in the folder named after the checkout alone is moved, and never drafted over", async () => {
  const repo = namedRepo("legacy");
  const old = path.join(home, "models", "legacy");
  mkdirSync(old, { recursive: true });
  const dsl = serializeModel(CLEAN);
  writeFileSync(path.join(old, "workspace.dsl"), dsl);
  writeFileSync(path.join(old, "workspace.dsl.bak"), "the backup\n");

  const read = await readModelAt(repo.dir, "HEAD");
  assert.ok(read?.model, read?.error ?? "no model");
  assert.ok(read.file);
  const dir = path.dirname(read.file);
  assert.match(path.basename(dir), /^legacy-[0-9a-f]{8}$/);
  assert.equal(readFileSync(path.join(dir, "workspace.dsl"), "utf8"), dsl);
  assert.equal(
    readFileSync(path.join(dir, "workspace.dsl.bak"), "utf8"),
    "the backup\n",
  );
  assert.equal(existsSync(old), false);

  const { runner, prompts } = recorded([CLEAN]);
  const head = repo.sh("rev-parse", "HEAD");
  assert.deepEqual(
    await startMapRead(
      { root: repo.dir, base: null, head },
      { runner, status: ready },
    ),
    { status: "refused", reason: "local" },
  );
  assert.equal(prompts.length, 0);
});

test("a map read finds a model in the folder named after the checkout alone before checking for one", async () => {
  const repo = namedRepo("unread");
  const old = path.join(home, "models", "unread");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "workspace.dsl"), serializeModel(CLEAN));

  const { runner, prompts } = recorded([CLEAN]);
  const head = repo.sh("rev-parse", "HEAD");
  assert.deepEqual(
    await startMapRead(
      { root: repo.dir, base: null, head },
      { runner, status: ready },
    ),
    { status: "refused", reason: "local" },
  );
  assert.equal(prompts.length, 0);
  assert.ok(existsSync(await localModelFile(repo.dir)));
  assert.equal(existsSync(old), false);
});

test("when both folders have a model, the repo key's wins and the other is left alone", async () => {
  const repo = namedRepo("both");
  await handWrite(repo.dir);
  const old = path.join(home, "models", "both", "workspace.dsl");
  mkdirSync(path.dirname(old), { recursive: true });
  const stale = structuredClone(CLEAN);
  stale.system.name = "Stale shop";
  writeFileSync(old, serializeModel(stale));

  const read = await readModelAt(repo.dir, "HEAD");
  assert.equal(read?.file, await localModelFile(repo.dir));
  assert.equal(await systemName(repo.dir), "Shop");
  assert.ok(existsSync(old));
});

test("a repo with no model in either folder gets none, and no folder is made", async () => {
  const repo = namedRepo("bare");
  assert.equal(await readModelAt(repo.dir, "HEAD"), null);
  assert.equal(existsSync(path.dirname(await localModelFile(repo.dir))), false);
  assert.equal(existsSync(path.join(home, "models", "bare")), false);
});

test("a repo with no model is told where a hand-written model goes, and no folder is made", async () => {
  const repo = namedRepo("unmodelled");
  const head = repo.sh("rev-parse", "HEAD");
  const response = await mapRoute.GET(
    new Request(
      `http://localhost/api/map?repo=${encodeURIComponent(repo.dir)}&rev=${head}`,
    ),
  );
  const body = (await response.json()) as MapResponse;
  assert.equal(body.status, "none");
  assert.equal(body.handFile, await localModelFile(repo.dir));
  assert.equal(existsSync(path.dirname(await localModelFile(repo.dir))), false);
});
