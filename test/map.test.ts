import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { buildMap, type MapResponse } from "../lib/map";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const write = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

function gitRepo() {
  const dir = tempDir("differ-map-test-");
  const sh = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  sh("init", "-q");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "Test");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) write(dir, file, text);
    sh("add", ".");
    sh("commit", "-qm", message);
    return sh("rev-parse", "HEAD");
  };
  return { dir, commit };
}

interface Comp {
  id: string;
  key: string;
  name: string;
  globs: string;
}

interface Spec {
  comps: Comp[];
  rels: [string, string, string][];
}

/** A Structurizr export, cut down to what differ reads. */
function workspace({ comps, rels }: Spec) {
  const byKey = new Map(comps.map((c) => [c.key, c.id]));
  return JSON.stringify({
    properties: { "code.tests": "test/**" },
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

/** The same model as `workspace`, as the DSL it would be exported from. */
function dsl({ comps, rels }: Spec) {
  const components = comps.map(
    (c) => `                ${c.key} = component "${c.name}" {
                    properties {
                        "code.globs" "${c.globs}"
                    }
                }`,
  );
  const arrows = rels.map(
    ([from, to, description]) =>
      `        app.web.${from} -> app.web.${to} "${description}"`,
  );
  return `workspace {
    !identifiers hierarchical
    properties {
        "code.tests" "test/**"
    }
    model {
        app = softwareSystem "App" {
            web = container "Web" {
${components.join("\n")}
            }
        }
${arrows.join("\n")}
    }
}
`;
}

const a = { id: "10", key: "a", name: "Alpha", globs: "src/a/**" };
const b = { id: "11", key: "b", name: "Beta", globs: "src/b/** src/{x,y}.ts" };
const c = { id: "12", key: "c", name: "Gamma", globs: "src/c/**" };

const BASE: Spec = { comps: [a, b], rels: [["a", "b", "Calls"]] };
const HEAD: Spec = {
  comps: [a, b, c],
  rels: [
    ["a", "b", "Asks"],
    ["b", "c", "Stores in"],
  ],
};

const asJson = (spec: Spec) => ({
  "architecture/workspace.json": workspace(spec),
});
const asDsl = (spec: Spec) => ({ "architecture/workspace.dsl": dsl(spec) });

/** A base and a head commit, with the model written by `models`. */
function change(models: (spec: Spec) => Record<string, string>) {
  const repo = gitRepo();
  const base = repo.commit(
    { "src/a/one.ts": "1\n", "src/b/two.ts": "2\n", ...models(BASE) },
    "base",
  );
  const head = repo.commit(
    {
      "src/a/one.ts": "1\nmore\n",
      "src/b/.hidden": "dotfile\n",
      "src/x.ts": "brace\n",
      "src/c/three.ts": "3\n",
      "src/loose.ts": "nobody's\n",
      "test/a.test.ts": "t\n",
      ...models(HEAD),
    },
    "head",
  );
  return { ...repo, base, head };
}

function assertTheChange(map: MapResponse) {
  assert.equal(map.status, "ok");
  assert.equal(map.baseModel, true);
  assert.equal(map.error, null);

  const state = Object.fromEntries(map.nodes.map((n) => [n.name, n.state]));
  assert.deepEqual(state, {
    Alpha: "touched",
    Beta: "touched",
    Gamma: "added",
  });

  const edges = Object.fromEntries(
    map.edges.map((e) => [e.key, [e.state, e.before ?? null]]),
  );
  assert.deepEqual(edges, {
    "app.web.a → app.web.b": ["changed", "Calls"],
    "app.web.b → app.web.c": ["added", null],
  });

  // Dotfiles and brace globs map; tests and the model itself stay off.
  assert.equal(map.fileComponents["src/b/.hidden"], "Beta");
  assert.equal(map.fileComponents["src/x.ts"], "Beta");
  assert.deepEqual(map.unmapped, ["src/loose.ts"]);
}

const jsonRepo = change(asJson);

test("the map compares models by identifier and arrows by their ends", async () => {
  assertTheChange(await buildMap(jsonRepo.dir, jsonRepo.base, jsonRepo.head));
});

test("a repo with only workspace.dsl maps the same change the same way", async () => {
  const repo = change(asDsl);
  assertTheChange(await buildMap(repo.dir, repo.base, repo.head));
});

test("when both files are committed, the DSL is the model", async () => {
  const repo = change((spec) => ({
    ...asDsl(spec),
    "architecture/workspace.json": workspace({
      ...spec,
      comps: spec.comps.map((x) => ({ ...x, name: `${x.name} (JSON)` })),
    }),
  }));
  assertTheChange(await buildMap(repo.dir, repo.base, repo.head));
});

test("a head DSL that can't be read says why, even with a JSON beside it", async () => {
  const repo = change(asJson);
  const head = repo.commit(
    {
      "architecture/workspace.dsl": "workspace {\n    !include model.dsl\n}\n",
      "src/a/one.ts": "1\nmore\nagain\n",
    },
    "add a DSL the reader can't take",
  );
  const map = await buildMap(repo.dir, repo.head, head);
  assert.equal(map.status, "none");
  assert.equal(map.error, "`!include` on line 2 isn't supported");
  assert.deepEqual(map.nodes, []);
});

test("a base DSL that can't be read counts as no base model", async () => {
  const repo = gitRepo();
  const base = repo.commit(
    {
      "src/a/one.ts": "1\n",
      "architecture/workspace.dsl":
        'workspace {\n    model {\n        group "G" {\n        }\n    }\n}\n',
    },
    "base",
  );
  const head = repo.commit(
    { "src/a/one.ts": "1\nmore\n", ...asDsl(HEAD) },
    "head",
  );
  const map = await buildMap(repo.dir, base, head);
  assert.equal(map.status, "ok");
  assert.equal(map.baseModel, false);
  assert.equal(map.error, null);
  assert.ok(map.nodes.length > 0);
  assert.ok(map.nodes.every((n) => n.state !== "added"));
});

test("a base with no model adds nothing", async () => {
  const map = await buildMap(jsonRepo.dir, null, jsonRepo.base);
  assert.equal(map.baseModel, false);
  assert.ok(map.nodes.every((n) => n.state !== "added"));
});

test("a repo with no model uses a DSL kept locally, without a structural diff", async () => {
  const repo = gitRepo();
  const home = tempDir("differ-home-");
  const base = repo.commit({ README: "x\n" }, "base");
  const head = repo.commit({ "src/a/one.ts": "1\n" }, "head");
  write(
    path.join(home, "models", path.basename(repo.dir)),
    "workspace.dsl",
    dsl(BASE),
  );

  const previousHome = process.env.DIFFER_HOME;
  process.env.DIFFER_HOME = home;
  try {
    const map = await buildMap(repo.dir, base, head);
    assert.equal(map.status, "ok");
    assert.equal(map.local, true);
    assert.equal(map.baseModel, false);
    assert.equal(map.fileComponents["src/a/one.ts"], "Alpha");
  } finally {
    // Restore npm test's throwaway DIFFER_HOME so later tests can use it.
    if (previousHome === undefined) delete process.env.DIFFER_HOME;
    else process.env.DIFFER_HOME = previousHome;
  }
});

test("a model that lists no tests or ignores keeps the built-in ones", async () => {
  const { parseDsl, parseModel } = await import("../lib/model");
  for (const model of [
    parseModel(
      JSON.stringify({ properties: {}, model: { softwareSystems: [] } }),
    ),
    parseDsl("workspace {\n    model {\n    }\n}\n"),
  ]) {
    assert.equal(model.isTest("test/models/item_test.rb"), true);
    assert.equal(model.isIgnored("package-lock.json"), true);
    assert.equal(model.isTest("app/models/item.rb"), false);
  }
});
