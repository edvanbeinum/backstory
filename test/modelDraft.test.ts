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

import { readDsl } from "../lib/dsl";
import type { Runner } from "../lib/flows/claude";
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

function gitRepo(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "backstory-draft-test-"));
  dirs.push(dir);
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

const available = async () => true;

async function draft(
  root: string,
  answers: (object | Error)[],
  redraft = false,
): Promise<{ status: DraftStatus; prompts: string[] }> {
  const { runner, prompts } = recorded(answers);
  const started = await startDraft(root, { runner, available, redraft });
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
    available: async () => false,
  });
  assert.deepEqual(status, { status: "unavailable", reason: "no-claude" });
  assert.deepEqual(await draftStatus(repo.dir), status);
  assert.equal(prompts.length, 0);
});

test("a repo that commits a model is never drafted", async () => {
  const repo = gitRepo({
    "architecture/workspace.dsl": "workspace {\n    model {\n    }\n}\n",
  });
  const { runner, prompts } = recorded([CLEAN]);
  const status = await startDraft(repo.dir, { runner, available });
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
  assert.deepEqual(await startDraft(repo.dir, { runner, available }), {
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

test("a redraft sent while a refused draft is still being checked still runs", async () => {
  const repo = gitRepo();
  await draft(repo.dir, [CLEAN]);
  const file = await localModelFile(repo.dir);

  const renamed = structuredClone(CLEAN);
  renamed.system.name = "Shop, redrafted";
  const { runner, prompts } = recorded([renamed]);
  const [stale, redraft] = await Promise.all([
    startDraft(repo.dir, { runner, available }),
    startDraft(repo.dir, { runner, available, redraft: true }),
  ]);
  assert.deepEqual(stale, { status: "refused", reason: "exists" });
  assert.equal(redraft.status, "running");
  await draftSettled(repo.dir);
  assert.equal((await draftStatus(repo.dir)).status, "done");
  assert.equal(prompts.length, 1);
  assert.match(readFileSync(file, "utf8"), /"Shop, redrafted"/);
});
