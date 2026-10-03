import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { buildMap } from "../lib/map";

const repo = mkdtempSync(path.join(os.tmpdir(), "differ-map-test-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const sh = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

interface Comp {
  id: string;
  key: string;
  name: string;
  globs: string;
}

/** A Structurizr export, cut down to what differ reads. */
function workspace(comps: Comp[], rels: [string, string, string][], dsl: string) {
  const byKey = new Map(comps.map((c) => [c.key, c.id]));
  return JSON.stringify({
    properties: {
      "code.tests": "test/**",
      "structurizr.dsl": Buffer.from(dsl).toString("base64"),
    },
    model: {
      softwareSystems: [
        {
          id: "1",
          name: "App",
          properties: { "structurizr.dsl.identifier": "app" },
          containers: [
            {
              id: "2",
              name: "Web",
              properties: { "structurizr.dsl.identifier": "app.web" },
              components: comps.map((c) => ({
                id: c.id,
                name: c.name,
                properties: {
                  "structurizr.dsl.identifier": `app.web.${c.key}`,
                  "code.globs": c.globs,
                },
                relationships: rels
                  .filter(([from]) => from === c.key)
                  .map(([, to, description], i) => ({
                    id: `${c.id}${i}`,
                    sourceId: c.id,
                    destinationId: byKey.get(to),
                    description,
                  })),
              })),
            },
          ],
        },
      ],
    },
  });
}

const a = { id: "10", key: "a", name: "Alpha", globs: "src/a/**" };
const b = { id: "11", key: "b", name: "Beta", globs: "src/b/** src/{x,y}.ts" };
const c = { id: "12", key: "c", name: "Gamma", globs: "src/c/**" };

sh("init", "-q");
sh("config", "user.email", "t@example.com");
sh("config", "user.name", "Test");
write("architecture/workspace.dsl", "v1");
write("architecture/workspace.json", workspace([a, b], [["a", "b", "Calls"]], "v1"));
write("src/a/one.ts", "1\n");
write("src/b/two.ts", "2\n");
sh("add", ".");
sh("commit", "-qm", "base");
const BASE = sh("rev-parse", "HEAD");

write("architecture/workspace.dsl", "v2");
write(
  "architecture/workspace.json",
  workspace([a, b, c], [["a", "b", "Asks"], ["b", "c", "Stores in"]], "v2"),
);
write("src/a/one.ts", "1\nmore\n");
write("src/b/.hidden", "dotfile\n");
write("src/x.ts", "brace\n");
write("src/c/three.ts", "3\n");
write("src/loose.ts", "nobody's\n");
write("test/a.test.ts", "t\n");
sh("add", ".");
sh("commit", "-qm", "head");
const HEAD = sh("rev-parse", "HEAD");

test("the map compares models by identifier and arrows by their ends", async () => {
  const map = await buildMap(repo, BASE, HEAD);
  assert.equal(map.status, "ok");
  assert.equal(map.baseModel, true);
  assert.equal(map.stale, false);

  const state = Object.fromEntries(map.nodes.map((n) => [n.name, n.state]));
  assert.deepEqual(state, { Alpha: "touched", Beta: "touched", Gamma: "added" });

  const edges = Object.fromEntries(map.edges.map((e) => [e.key, [e.state, e.before ?? null]]));
  assert.deepEqual(edges, {
    "app.web.a → app.web.b": ["changed", "Calls"],
    "app.web.b → app.web.c": ["added", null],
  });

  // Dotfiles and brace globs map; tests and the model itself stay off.
  assert.equal(map.fileComponents["src/b/.hidden"], "Beta");
  assert.equal(map.fileComponents["src/x.ts"], "Beta");
  assert.deepEqual(map.unmapped, ["src/loose.ts"]);
});

test("a DSL edited without a re-export reads as stale", async () => {
  write("architecture/workspace.dsl", "v3");
  sh("commit", "-qam", "edit the DSL only");
  const map = await buildMap(repo, HEAD, sh("rev-parse", "HEAD"));
  assert.equal(map.stale, true);
});

test("a base with no model adds nothing", async () => {
  const map = await buildMap(repo, null, BASE);
  assert.equal(map.baseModel, false);
  assert.ok(map.nodes.every((n) => n.state !== "added"));
});

test("a repo with no model uses one kept locally, without a structural diff", async () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), "differ-local-model-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "differ-home-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", plain, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    writeFileSync(path.join(plain, "README"), "x\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(path.join(plain, "src", "a"), { recursive: true });
    writeFileSync(path.join(plain, "src", "a", "one.ts"), "1\n");
    git("add", ".");
    git("commit", "-qm", "head");

    const dir = path.join(home, "models", path.basename(plain));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "workspace.json"), workspace([a, b], [["a", "b", "Calls"]], "v1"));
    writeFileSync(path.join(dir, "workspace.dsl"), "v1");

    process.env.DIFFER_HOME = home;
    const map = await buildMap(plain, base, git("rev-parse", "HEAD"));
    assert.equal(map.status, "ok");
    assert.equal(map.local, true);
    assert.equal(map.baseModel, false);
    assert.equal(map.stale, false);
    assert.equal(map.fileComponents["src/a/one.ts"], "Alpha");
  } finally {
    delete process.env.DIFFER_HOME;
    rmSync(plain, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a model that lists no tests or ignores keeps the built-in ones", async () => {
  const { parseModel } = await import("../lib/model");
  const model = parseModel(JSON.stringify({ properties: {}, model: { softwareSystems: [] } }));
  assert.equal(model.isTest("test/models/item_test.rb"), true);
  assert.equal(model.isIgnored("package-lock.json"), true);
  assert.equal(model.isTest("app/models/item.rb"), false);
});
