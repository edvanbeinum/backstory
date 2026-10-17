import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { buildMap, type MapResponse } from "../lib/map";
import { groupByComponent } from "../lib/mapGroups";
import { localModelFile } from "../lib/model";

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
  const dir = tempDir("backstory-map-test-");
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
  key: string;
  name: string;
  globs: string;
}

interface Spec {
  comps: Comp[];
  rels: [string, string, string][];
}

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

const a = { key: "a", name: "Alpha", globs: "src/a/**" };
const b = { key: "b", name: "Beta", globs: "src/b/** src/{x,y}.ts" };
const c = { key: "c", name: "Gamma", globs: "src/c/**" };

const BASE: Spec = { comps: [a, b], rels: [["a", "b", "Calls"]] };
const HEAD: Spec = {
  comps: [a, b, c],
  rels: [
    ["a", "b", "Asks"],
    ["b", "c", "Stores in"],
  ],
};

const asDsl = (spec: Spec) => ({ "architecture/workspace.dsl": dsl(spec) });

function change() {
  const repo = gitRepo();
  const base = repo.commit(
    { "src/a/one.ts": "1\n", "src/b/two.ts": "2\n", ...asDsl(BASE) },
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
      ...asDsl(HEAD),
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

const changeRepo = change();

test("the map compares models by identifier and arrows by their ends", async () => {
  assertTheChange(
    await buildMap(changeRepo.dir, changeRepo.base, changeRepo.head),
  );
});

test("a head DSL that can't be read says why", async () => {
  const repo = change();
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

test("a base DSL that can't be read counts as no base model, and says why", async () => {
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
  assert.match(map.baseError ?? "", /`group` on line 3/);
  assert.ok(map.nodes.length > 0);
  assert.ok(map.nodes.every((n) => n.state !== "added"));
});

test("a change that touches no component has the whole system for Show map, unchanged; one that touches one doesn't", async () => {
  const repo = gitRepo();
  const model = `workspace {
    !identifiers hierarchical
    model {
        shopper = person "Shopper"
        payments = softwareSystem "Payments"
        app = softwareSystem "App" {
            web = container "Web" {
                a = component "Alpha" {
                    properties {
                        "code.globs" "src/a/**"
                    }
                }
                b = component "Beta"
            }
        }
        shopper -> app.web.a "Uses"
        app.web.a -> app.web.b "Calls"
        app.web.b -> payments "Charges"
        shopper -> app "Visits"
    }
}
`;
  const base = repo.commit(
    { "src/a/one.ts": "1\n", "architecture/workspace.dsl": model },
    "base",
  );
  const docs = repo.commit({ "README.md": "x\n" }, "docs");
  const map = await buildMap(repo.dir, base, docs);
  assert.equal(map.status, "ok");
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(
    map.whole?.nodes.map((n) => [n.id, n.state, n.files.length]).sort(),
    [
      ["app.web.a", "neighbour", 0],
      ["app.web.b", "neighbour", 0],
      ["payments", "neighbour", 0],
      ["shopper", "neighbour", 0],
    ],
  );
  assert.deepEqual(map.whole?.edges.map((e) => [e.key, e.state]).sort(), [
    ["app.web.a → app.web.b", "same"],
    ["app.web.b → payments", "same"],
    ["shopper → app.web.a", "same"],
  ]);

  const touched = repo.commit({ "src/a/one.ts": "2\n" }, "touch");
  const focused = await buildMap(repo.dir, docs, touched);
  assert.equal(focused.nodes.length > 0, true);
  assert.equal(focused.whole, undefined);
});

test("a base with no model adds nothing", async () => {
  const map = await buildMap(changeRepo.dir, null, changeRepo.base);
  assert.equal(map.baseModel, false);
  assert.ok(map.nodes.every((n) => n.state !== "added"));
});

test("a repo with no model uses a DSL kept locally, without a structural diff", async () => {
  const repo = gitRepo();
  const home = tempDir("backstory-home-");
  const base = repo.commit({ README: "x\n" }, "base");
  const head = repo.commit({ "src/a/one.ts": "1\n" }, "head");

  const previousHome = process.env.BACKSTORY_HOME;
  process.env.BACKSTORY_HOME = home;
  try {
    const file = await localModelFile(repo.dir);
    write(path.dirname(file), "workspace.dsl", dsl(BASE));
    const map = await buildMap(repo.dir, base, head);
    assert.equal(map.status, "ok");
    assert.equal(map.local, true);
    assert.equal(map.baseModel, false);
    assert.equal(map.fileComponents["src/a/one.ts"], "Alpha");
    assert.equal(map.modelFile, file);
  } finally {
    // Restore npm test's throwaway BACKSTORY_HOME so later tests can use it.
    if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
    else process.env.BACKSTORY_HOME = previousHome;
  }
});

test("the old drafted local model is skipped, and the map says where a hand-written one goes; a committed one says neither", async () => {
  const repo = gitRepo();
  const home = tempDir("backstory-home-");
  const base = repo.commit({ README: "x\n" }, "base");
  const head = repo.commit({ "src/a/one.ts": "1\n" }, "head");

  const previousHome = process.env.BACKSTORY_HOME;
  process.env.BACKSTORY_HOME = home;
  try {
    const file = await localModelFile(repo.dir);
    write(path.dirname(file), "workspace.dsl", draftedDsl("backstory.drafted"));
    const map = await buildMap(repo.dir, base, head);
    assert.equal(map.status, "none");
    assert.equal(map.modelFile, null);
    assert.equal(map.handFile, file);
    assert.equal(map.draft?.status, "idle");

    const committed = await buildMap(
      changeRepo.dir,
      changeRepo.base,
      changeRepo.head,
    );
    assert.equal(committed.source, "committed");
    assert.equal(committed.modelFile, null);
    assert.equal(committed.handFile, undefined);
    assert.equal(committed.draft, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.BACKSTORY_HOME;
    else process.env.BACKSTORY_HOME = previousHome;
  }
});

function draftedDsl(property: string): string {
  return dsl(BASE).replace(
    '"code.tests" "test/**"',
    `"code.tests" "test/**"\n        "${property}" "2026-10-05"`,
  );
}

test("a model that lists no tests or ignores keeps the built-in ones", async () => {
  const { parseDsl } = await import("../lib/model");
  const model = parseDsl("workspace {\n    model {\n    }\n}\n");
  assert.equal(model.isTest("test/models/item_test.rb"), true);
  assert.equal(model.isIgnored("package-lock.json"), true);
  assert.equal(model.isTest("app/models/item.rb"), false);
});

test("groupByComponent groups in the map's order and keeps every file", () => {
  const files = ["web/b.ts", "test/x.ts", "api/a.ts", "web/c.ts", "README"].map(
    (path) => ({ path }),
  );
  const groups = groupByComponent(
    files,
    { "web/b.ts": "Web", "web/c.ts": "Web", "api/a.ts": "API" },
    [{ name: "API" }, { name: "Web" }],
  );
  assert.deepEqual(
    groups.map((g) => [g.component, g.files.map((f) => f.path)]),
    [
      ["API", ["api/a.ts"]],
      ["Web", ["web/b.ts", "web/c.ts"]],
      [null, ["test/x.ts", "README"]],
    ],
  );
  const out = groups.flatMap((g) => g.files.map((f) => f.path));
  assert.equal(out.length, files.length);
  assert.equal(new Set(out).size, files.length);
});
