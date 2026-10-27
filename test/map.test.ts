import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { resolveRepo } from "../lib/git";
import { buildMap, buildWorkingMap, type MapResponse } from "../lib/map";
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
  return { dir, sh, commit };
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
    Web: "neighbour",
    App: "neighbour",
  });
  assert.deepEqual(
    map.nodes.filter((n) => n.group).map((n) => [n.name, n.parent]),
    [
      ["Web", "app"],
      ["App", null],
    ],
  );

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
  assert.equal(map.fileComponents["src/loose.ts"], undefined);
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

const SHOP = (extra = "") => `workspace {
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
            db = container "Db"
${extra}
        }
        shopper -> app.web.a "Uses"
        shopper -> app.web "Opens"
        app.web.a -> app.web.b "Calls"
        app.web.b -> payments "Charges"
        app.web.b -> app.db "Reads"
        shopper -> app "Visits"
    }
}
`;

function shop(extra = "") {
  const repo = gitRepo();
  const base = repo.commit(
    { "src/a/one.ts": "1\n", "architecture/workspace.dsl": SHOP(extra) },
    "base",
  );
  const docs = repo.commit({ "README.md": "x\n" }, "docs");
  return { ...repo, base, docs };
}

test("a change that touches no component has the whole system for Show map, each element in its parent's box; one that touches one doesn't", async () => {
  const repo = shop();
  const map = await buildMap(repo.dir, repo.base, repo.docs);
  assert.equal(map.status, "ok");
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(
    map.whole?.nodes
      .map((n) => [n.id, n.parent, n.group, n.state, n.files.length])
      .sort(),
    [
      ["app", null, true, "neighbour", 0],
      ["app.db", "app", false, "neighbour", 0],
      ["app.web", "app", true, "neighbour", 0],
      ["app.web.a", "app.web", false, "neighbour", 0],
      ["app.web.b", "app.web", false, "neighbour", 0],
      ["payments", null, false, "neighbour", 0],
      ["shopper", null, false, "neighbour", 0],
    ],
  );
  assert.deepEqual(
    map.whole?.edges.map((e) => [e.key, e.description, e.state]).sort(),
    [
      ["app.web.a → app.web.b", "Calls", "same"],
      ["app.web.b → app.db", "Reads", "same"],
      ["app.web.b → payments", "Charges", "same"],
      ["shopper → app", "Visits", "same"],
      ["shopper → app.web", "Opens", "same"],
      ["shopper → app.web.a", "Uses", "same"],
    ],
  );

  const touched = repo.commit({ "src/a/one.ts": "2\n" }, "touch");
  const focused = await buildMap(repo.dir, repo.docs, touched);
  assert.equal(focused.nodes.length > 0, true);
  assert.equal(focused.whole, undefined);
});

test("the focused map draws a changed component inside its container and system, and keeps arrows to them", async () => {
  const repo = shop();
  const touched = repo.commit({ "src/a/one.ts": "2\n" }, "touch");
  const map = await buildMap(repo.dir, repo.docs, touched);
  const node = (id: string) => map.nodes.find((n) => n.id === id);
  assert.deepEqual(
    [node("app.web.a")?.state, node("app.web.a")?.parent],
    ["touched", "app.web"],
  );
  assert.deepEqual(
    ["app.web", "app"].map((id) => [node(id)?.group, node(id)?.state]),
    [
      [true, "neighbour"],
      [true, "neighbour"],
    ],
  );
  assert.equal(node("app")?.parent, null);
  assert.ok(node("shopper"));
  const edges = Object.fromEntries(
    map.edges.map((e) => [e.key, e.description]),
  );
  assert.equal(edges["shopper → app.web"], "Opens");
  assert.equal(edges["shopper → app"], "Visits");
});

test("a container added between base and head is drawn as a new box, and a removed one as removed", async () => {
  const repo = shop();
  const withQueue = SHOP(`            queue = container "Queue" {
                q = component "Worker" {
                    properties {
                        "code.globs" "src/q/**"
                    }
                }
            }`);
  const added = repo.commit(
    { "architecture/workspace.dsl": withQueue, "src/q/work.ts": "w\n" },
    "add the queue",
  );
  const map = await buildMap(repo.dir, repo.docs, added);
  const queue = map.nodes.find((n) => n.id === "app.queue");
  assert.deepEqual([queue?.group, queue?.state], [true, "added"]);
  assert.equal(
    map.nodes.find((n) => n.id === "app.queue.q")?.parent,
    "app.queue",
  );

  const gone = repo.commit(
    { "architecture/workspace.dsl": SHOP() },
    "remove the queue",
  );
  const back = await buildMap(repo.dir, added, gone);
  const removed = back.nodes.find((n) => n.id === "app.queue");
  assert.deepEqual([removed?.group, removed?.state], [true, "removed"]);
});

test("a container whose own files changed keeps them when drawn as the box around a neighbour", async () => {
  const api = `            api = container "Api" {
                properties {
                    "code.globs" "src/api/**"
                }
                auth = component "Auth" {
                    properties {
                        "code.globs" "src/auth/**"
                    }
                }
            }`;
  const repo = shop(api);
  const touched = repo.commit(
    {
      "src/api/server.ts": "s\n",
      "architecture/workspace.dsl": SHOP(
        `${api}\n            app.api.auth -> app.db "Reads"`,
      ),
    },
    "touch the api",
  );
  const map = await buildMap(repo.dir, repo.docs, touched);
  const node = (id: string) => map.nodes.find((n) => n.id === id);
  assert.deepEqual(
    [node("app.api")?.group, node("app.api")?.state, node("app.api")?.files],
    [true, "touched", ["src/api/server.ts"]],
  );
  assert.equal(node("app.api.auth")?.parent, "app.api");
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

/** A repo at HEAD's model, with the files given committed beside it. */
function workingRepo(files: Record<string, string>) {
  const repo = gitRepo();
  repo.commit({ ...files, ...asDsl(HEAD) }, "head");
  return {
    ...repo,
    map: async () => buildWorkingMap(await resolveRepo(repo.dir)),
  };
}

test("uncommitted work puts every changed app file, staged, unstaged or untracked, on HEAD's model, with nothing added or removed", async () => {
  const repo = workingRepo({ "src/a/one.ts": "1\n", "src/b/two.ts": "2\n" });
  write(repo.dir, "src/a/one.ts", "1\nmore\n");
  write(repo.dir, "src/b/two.ts", "2\nstaged\n");
  repo.sh("add", "src/b/two.ts");
  write(repo.dir, "src/c/three.ts", "3\nnew\n");

  const map = await repo.map();
  assert.equal(map.status, "ok");
  assert.equal(map.baseModel, true);
  assert.equal(map.source, "committed");
  const byName = new Map(map.nodes.map((n) => [n.name, n]));
  assert.deepEqual(
    Object.fromEntries(map.nodes.map((n) => [n.name, n.state])),
    {
      Alpha: "touched",
      Beta: "touched",
      Gamma: "touched",
      Web: "neighbour",
      App: "neighbour",
    },
  );
  assert.deepEqual(byName.get("Alpha")?.fileStats, [
    { path: "src/a/one.ts", additions: 1, deletions: 0, status: "M" },
  ]);
  assert.deepEqual(byName.get("Beta")?.files, ["src/b/two.ts"]);
  assert.deepEqual(byName.get("Gamma")?.fileStats, [
    { path: "src/c/three.ts", additions: 2, deletions: 0, status: "A" },
  ]);
  assert.deepEqual(map.fileComponents, {
    "src/a/one.ts": "Alpha",
    "src/b/two.ts": "Beta",
    "src/c/three.ts": "Gamma",
  });
  assert.ok(map.edges.length > 0);
  assert.ok(map.edges.every((e) => e.state === "same"));
});

test("a file deleted in the working tree maps by HEAD's model", async () => {
  const repo = workingRepo({ "src/a/one.ts": "1\n", "src/a/gone.ts": "x\n" });
  rmSync(path.join(repo.dir, "src/a/gone.ts"));
  const alpha = (await repo.map()).nodes.find((n) => n.name === "Alpha");
  assert.deepEqual(alpha?.fileStats, [
    { path: "src/a/gone.ts", additions: 0, deletions: 1, status: "D" },
  ]);
});

test("a staged rename on uncommitted work names both paths' component", async () => {
  const repo = workingRepo({ "src/a/one.ts": "the same text\n" });
  mkdirSync(path.join(repo.dir, "src/b"), { recursive: true });
  repo.sh("mv", "src/a/one.ts", "src/b/moved.ts");
  const map = await repo.map();
  assert.deepEqual(map.fileComponents, {
    "src/b/moved.ts": "Beta",
    "src/a/one.ts": "Beta",
  });
});

test("an untracked file no component has is off the map, and an untracked test is in neither", async () => {
  const repo = workingRepo({ "src/a/one.ts": "1\n" });
  write(repo.dir, "src/loose.ts", "nobody's\n");
  write(repo.dir, "test/new.test.ts", "t\n");
  const map = await repo.map();
  assert.deepEqual(map.fileComponents, {});
});

test("uncommitted work maps in a repo with a file named HEAD", async () => {
  const repo = workingRepo({ HEAD: "x\n", "src/a/one.ts": "1\n" });
  write(repo.dir, "src/a/one.ts", "1\nmore\n");
  const map = await repo.map();
  assert.deepEqual(map.fileComponents, { "src/a/one.ts": "Alpha" });
});

test("a clean working tree touches nothing and has the whole system", async () => {
  const map = await workingRepo({ "src/a/one.ts": "1\n" }).map();
  assert.equal(map.status, "ok");
  assert.deepEqual(map.nodes, []);
  assert.ok(map.whole && map.whole.nodes.length > 0);
});

test("uncommitted work in a repo with no commit yet has no map and nothing to draft", async () => {
  const repo = gitRepo();
  write(repo.dir, "src/a/one.ts", "1\n");
  const map = await buildWorkingMap(await resolveRepo(repo.dir));
  assert.equal(map.status, "none");
  assert.equal(map.draft, undefined);
});
