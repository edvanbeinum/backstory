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

import type { Runner } from "../lib/ai/provider";
import { readDsl } from "../lib/dsl";
import { isAppCode, localModelFile, readModelAt } from "../lib/model";
import {
  draftSettled,
  draftStatus,
  startDraft,
  type DraftStatus,
} from "../lib/models/draft";
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

async function draft(
  root: string,
  answers: (object | Error)[],
  redraft = false,
): Promise<{ status: DraftStatus; prompts: string[] }> {
  const { runner, prompts } = recorded(answers);
  const started = await startDraft(root, { runner, status: ready, redraft });
  assert.equal(started.status, "running");
  await draftSettled(root);
  return { status: await draftStatus(root), prompts };
}

test("a repo with no model gets a draft on this machine, and the repo is untouched", async () => {
  const repo = gitRepo();
  const { status, prompts } = await draft(repo.dir, [CLEAN]);

  assert.equal(status.status, "done", JSON.stringify(status));
  assert.equal(prompts.length, 1);
  const file = await localModelFile(repo.dir);
  assert.ok(file.startsWith(path.join(home, "models") + path.sep));
  assert.ok(existsSync(file));

  const read = await readModelAt(repo.dir, "HEAD");
  assert.ok(read?.model, read?.error ?? "no model");
  assert.equal(read.local, true);
  assert.equal(read.file, file);
  assert.match(read.drafted ?? "", /^\d{4}-\d{2}-\d{2}$/);

  const model = read.model;
  const appFiles = repo
    .sh("ls-files")
    .split("\n")
    .filter((f) => isAppCode(model, f));
  assert.deepEqual(appFiles, [
    "src/app/main.ts",
    "src/app/util.ts",
    "src/sync/engine.ts",
  ]);
  for (const f of appFiles) assert.equal(model.match(f).length, 1, f);

  assert.equal(repo.sh("status", "--porcelain", "--ignored"), "");
  assert.match(
    readFileSync(file, "utf8"),
    /^\/\/ Drafted by Claude[\s\S]*Every app file at \w{7} matches exactly one component\./,
  );
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
  const text = serializeModel(awkward, {
    header: ["A header line", "", "with\na newline"],
    drafted: "2026-10-05",
  });
  const ws = readDsl(text);

  assert.deepEqual(ws.properties, {
    "backstory.drafted": "2026-10-05",
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
  assert.match(
    text,
    /^\/\/ A header line\n\/\/\n\/\/ with a newline\n\/\/ Left out 2 relationships /,
  );
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
  const { status, prompts } = await draft(repo.dir, [MESSY, fix]);

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /src\/sync\/engine\.ts/);
  assert.match(
    prompts[1],
    /src\/app\/util\.ts ← shop\.web\.app, shop\.web\.util/,
  );
  assert.ok(!prompts[1].includes("main.test.ts"));
  assert.equal(status.status, "done");
  if (status.status !== "done") return;
  assert.equal(status.unmatched, 0);
  assert.equal(status.ambiguous, 0);
  assert.equal(status.costUsd, 1);
});

test("what the fix-up leaves is listed in the file and counted", async () => {
  const repo = gitRepo();
  const fix: GlobFixOutput = {
    components: [{ id: "shop.web.app", globs: ["src/app/main.ts"] }],
  };
  const { status, prompts } = await draft(repo.dir, [MESSY, fix]);

  assert.equal(prompts.length, 2);
  assert.equal(status.status, "done");
  if (status.status !== "done") return;
  assert.equal(status.unmatched, 1);
  assert.equal(status.ambiguous, 0);
  const text = readFileSync(await localModelFile(repo.dir), "utf8");
  assert.match(
    text,
    /\/\/ 1 app file matches no component:\n\/\/ {3}src\/sync\/engine\.ts\n/,
  );
});

test("a failed run says why and writes nothing", async () => {
  const repo = gitRepo();
  const { status } = await draft(repo.dir, [
    new Error("Claude Code failed: out of credit"),
  ]);
  assert.deepEqual(status, {
    status: "failed",
    error: "Claude Code failed: out of credit",
  });
  assert.equal(existsSync(await localModelFile(repo.dir)), false);
});

test("without Claude Code, no draft starts", async () => {
  const repo = gitRepo();
  const { runner, prompts } = recorded([CLEAN]);
  const status = await startDraft(repo.dir, {
    runner,
    status: async () => "missing",
  });
  assert.deepEqual(status, { status: "unavailable", reason: "no-claude" });
  assert.deepEqual(await draftStatus(repo.dir), status);
  assert.equal(prompts.length, 0);
});

test("with Claude Code logged out, no draft starts", async () => {
  const repo = gitRepo();
  const { runner, prompts } = recorded([CLEAN]);
  const status = await startDraft(repo.dir, {
    runner,
    status: async () => "logged-out",
  });
  assert.deepEqual(status, { status: "unavailable", reason: "logged-out" });
  assert.equal(prompts.length, 0);
});

test("a repo that commits a model is never drafted", async () => {
  const repo = gitRepo({
    "architecture/workspace.dsl": "workspace {\n    model {\n    }\n}\n",
  });
  const { runner, prompts } = recorded([CLEAN]);
  const status = await startDraft(repo.dir, { runner, status: ready });
  assert.deepEqual(status, { status: "refused", reason: "committed" });
  assert.deepEqual(await draftStatus(repo.dir), { status: "idle" });
  assert.equal(prompts.length, 0);
});

test("a local model is only replaced by a redraft, which keeps the old one", async () => {
  const repo = gitRepo();
  await draft(repo.dir, [CLEAN]);
  const file = await localModelFile(repo.dir);
  const first = readFileSync(file, "utf8");

  const { runner, prompts } = recorded([CLEAN]);
  assert.deepEqual(await startDraft(repo.dir, { runner, status: ready }), {
    status: "refused",
    reason: "exists",
  });
  assert.equal(prompts.length, 0);
  assert.equal((await draftStatus(repo.dir)).status, "done");

  const renamed = structuredClone(CLEAN);
  renamed.system.name = "Shop, redrafted";
  const { status } = await draft(repo.dir, [renamed], true);
  assert.equal(status.status, "done");
  const second = readFileSync(file, "utf8");
  assert.equal(readFileSync(`${file}.bak`, "utf8"), first);
  assert.match(second, /"Shop, redrafted"/);

  const failed = await draft(repo.dir, [new Error("timed out")], true);
  assert.equal(failed.status.status, "failed");
  assert.equal(readFileSync(file, "utf8"), second);
  assert.equal(readFileSync(`${file}.bak`, "utf8"), first);
});

const systemName = async (root: string) =>
  (await readModelAt(root, "HEAD"))?.model?.elements.get("shop")?.name;

test("two repos with the same folder name each get their own model, and a redraft on one leaves the other alone", async () => {
  const one = namedRepo("api");
  const two = namedRepo("api", { "src/app/extra.ts": "export const x = 1;\n" });
  const renamed = structuredClone(CLEAN);
  renamed.system.name = "Other shop";
  assert.equal((await draft(one.dir, [CLEAN])).status.status, "done");
  assert.equal((await draft(two.dir, [renamed])).status.status, "done");

  const oneFile = await localModelFile(one.dir);
  const twoFile = await localModelFile(two.dir);
  assert.notEqual(oneFile, twoFile);
  assert.ok(existsSync(oneFile));
  assert.ok(existsSync(twoFile));
  assert.equal(await systemName(one.dir), "Shop");
  assert.equal(await systemName(two.dir), "Other shop");

  const before = readFileSync(twoFile);
  const redrafted = structuredClone(CLEAN);
  redrafted.system.name = "Shop, redrafted";
  assert.equal((await draft(one.dir, [redrafted], true)).status.status, "done");
  assert.equal(await systemName(one.dir), "Shop, redrafted");
  assert.deepEqual(readFileSync(twoFile), before);
  assert.equal(existsSync(`${twoFile}.bak`), false);
});

test("every worktree of a repo reads the same model", async () => {
  const repo = gitRepo();
  const parent = mkdtempSync(path.join(os.tmpdir(), "backstory-worktree-"));
  dirs.push(parent);
  const worktree = path.join(parent, "second");
  repo.sh("worktree", "add", "-q", "--detach", worktree);
  await draft(repo.dir, [CLEAN]);

  const file = await localModelFile(repo.dir);
  assert.equal(await localModelFile(worktree), file);
  const read = await readModelAt(worktree, "HEAD");
  assert.ok(read?.model, read?.error ?? "no model");
  assert.equal(read.local, true);
  assert.equal(read.file, file);
});

test("a model in the folder named after the checkout alone is moved, and never silently redrafted", async () => {
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
  assert.deepEqual(await startDraft(repo.dir, { runner, status: ready }), {
    status: "refused",
    reason: "exists",
  });
  assert.equal(prompts.length, 0);
});

test("a Draft finds a model in the folder named after the checkout alone before checking for one", async () => {
  const repo = namedRepo("unread");
  const old = path.join(home, "models", "unread");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "workspace.dsl"), serializeModel(CLEAN));

  const { runner, prompts } = recorded([CLEAN]);
  assert.deepEqual(await startDraft(repo.dir, { runner, status: ready }), {
    status: "refused",
    reason: "exists",
  });
  assert.equal(prompts.length, 0);
  assert.ok(existsSync(await localModelFile(repo.dir)));
  assert.equal(existsSync(old), false);
});

test("when both folders have a model, the repo key's wins and the other is left alone", async () => {
  const repo = namedRepo("both");
  await draft(repo.dir, [CLEAN]);
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

test("a redraft sent while a refused draft is still being checked still runs", async () => {
  const repo = gitRepo();
  await draft(repo.dir, [CLEAN]);
  const file = await localModelFile(repo.dir);

  const renamed = structuredClone(CLEAN);
  renamed.system.name = "Shop, redrafted";
  const { runner, prompts } = recorded([renamed]);
  // Let the stale draft claim the repo before the redraft arrives: both
  // resolve the model directory first, and that ordering isn't promised.
  // Stop waiting once the stale draft has settled too, since its claim can
  // come and go between two polls and would otherwise leave this spinning.
  const stale = startDraft(repo.dir, { runner, status: ready });
  let settled = false;
  const markSettled = () => (settled = true);
  stale.then(markSettled, markSettled);
  while (!settled && (await draftStatus(repo.dir)).status !== "running") {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const redraft = await startDraft(repo.dir, {
    runner,
    status: ready,
    redraft: true,
  });
  assert.deepEqual(await stale, { status: "refused", reason: "exists" });
  assert.equal(redraft.status, "running");
  await draftSettled(repo.dir);
  assert.equal((await draftStatus(repo.dir)).status, "done");
  assert.equal(prompts.length, 1);
  assert.match(readFileSync(file, "utf8"), /"Shop, redrafted"/);
});
