import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import * as data from "../app/api/data/route";
import * as diff from "../app/api/diff/route";
import * as fetchRoute from "../app/api/fetch/route";
import * as map from "../app/api/map/route";
import * as session from "../app/api/session/route";
import { BRANCH_REV, STACK_REV } from "../lib/constants";
import type { DataResponse } from "../lib/data/types";
import { resolveRepo } from "../lib/git";
import type { MapResponse } from "../lib/map";
import type { DiffResponse, SessionResponse } from "../lib/types";
import { viewRange } from "../lib/view";
import { quietLoginShell, standIns } from "./standins";

quietLoginShell();
// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-stack-home-"),
);

const scratch = mkdtempSync(path.join(os.tmpdir(), "backstory-stack-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const MODEL = `workspace {
    !identifiers hierarchical
    model {
        app = softwareSystem "App" {
            web = container "Web" {
                code = component "Code" {
                    properties {
                        "code.globs" "src/**"
                    }
                }
            }
        }
    }
}
`;

const THINGS = "CREATE TABLE things (id integer PRIMARY KEY);\n";

/**
 * A `gh` answering `gh pr list --head <branch>` from `pr-<branch>.json`
 * beside it, the open-PR query from `open.json`, and anything else as a PR
 * with no threads, logging every argv.
 */
const GH = `PATH=/usr/bin:/bin
dir="\${0%/*}"
echo "$*" >> "$dir/gh.log"
case "$*" in
  "pr list"*) cat "$dir/pr-$4.json" 2>/dev/null || echo "[]" ;;
  *"pullRequests(states"*) cat "$dir/open.json" ;;
  *) echo '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}' ;;
esac`;

let ghDir = "";
const savedPath = process.env.PATH;
before(() => {
  ghDir = standIns({ gh: GH });
  process.env.PATH = `${ghDir}:/usr/bin:/bin`;
});
after(() => {
  process.env.PATH = savedPath;
  rmSync(ghDir, { recursive: true, force: true });
});

const pr = (number: number, head: string, base: string) => ({
  number,
  title: head,
  body: "",
  url: `https://github.com/acme/app/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  baseRefName: base,
  headRefName: head,
  author: { login: "author" },
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
});

/** GitHub with three open PRs, c onto b, b onto a, and a onto `start`. */
function openPrs(start: string) {
  const prs = [
    pr(3, "stack-c", "stack-b"),
    pr(2, "stack-b", "stack-a"),
    pr(1, "stack-a", start),
  ];
  for (const p of prs)
    writeFileSync(
      path.join(ghDir, `pr-${p.headRefName}.json`),
      JSON.stringify([p]),
    );
  writeFileSync(
    path.join(ghDir, "open.json"),
    JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: prs.map(({ headRefName, baseRefName }) => ({
              headRefName,
              baseRefName,
            })),
          },
        },
      },
    }),
  );
  writeFileSync(path.join(ghDir, "gh.log"), "");
}

const ghLog = () => readFileSync(path.join(ghDir, "gh.log"), "utf8");

let count = 0;

const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/**
 * A bare origin at `…/acme/app.git`, so its `file://` URL reads as the
 * `acme/app` repo, with `main`, `epic` one commit past it, and a stack of
 * three branches off `start`: `stack-a` adds two files, `stack-b` two more
 * and a table, and `stack-c` one. `main` moves on after the stack forks.
 */
function origin(start: "main" | "epic") {
  const dir = path.join(scratch, String(++count));
  const bare = path.join(dir, "acme", "app.git");
  const author = path.join(dir, "author");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", author]);
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(author, name)), { recursive: true });
      writeFileSync(path.join(author, name), text);
    }
    run(author, "add", "-A");
    run(author, "commit", "-qm", message);
  };
  commit(
    {
      "src/base.ts": "base\n",
      "architecture/workspace.dsl": MODEL,
      "db/schema.sql": THINGS,
    },
    "Start",
  );
  run(author, "checkout", "-qb", "epic");
  commit({ "src/epic.ts": "epic\n" }, "Epic");
  run(author, "checkout", "-qb", "stack-a", start);
  commit({ "src/a1.ts": "a1\n", "src/a2.ts": "a2\n" }, "Stack A");
  run(author, "checkout", "-qb", "stack-b");
  commit(
    {
      "src/b1.ts": "b1\n",
      "src/b2.ts": "b2\n",
      "db/schema.sql": `${THINGS}CREATE TABLE stacks (id integer PRIMARY KEY);\n`,
    },
    "Stack B",
  );
  run(author, "checkout", "-qb", "stack-c");
  commit({ "src/c1.ts": "c1\n" }, "Stack C");
  run(author, "checkout", "-q", "main");
  commit({ "src/main-only.ts": "main\n" }, "Main moves on");
  run(
    author,
    "push",
    "-q",
    `file://${bare}`,
    "main",
    "epic",
    "stack-a",
    "stack-b",
    "stack-c",
  );
  openPrs(start);
  return { dir, url: `file://${bare}` };
}

/** A clone of all of origin, with a local branch for each of the stack's. */
function fullClone(start: "main" | "epic") {
  const { dir, url } = origin(start);
  const root = path.join(dir, "mine");
  execFileSync("git", ["clone", "-q", url, root], { stdio: "ignore" });
  for (const b of ["stack-a", "stack-b", "stack-c"])
    run(root, "branch", "-q", b, `origin/${b}`);
  return { root, git: (...args: string[]) => run(root, ...args) };
}

/**
 * A clone of `main` alone, with `stack-c` and `stack-b` fetched by hand and
 * nothing of `epic`, where this stack starts.
 */
function cloneWithoutStart() {
  const { dir, url } = origin("epic");
  const root = path.join(dir, "mine");
  execFileSync(
    "git",
    ["clone", "-q", "--single-branch", "-b", "main", url, root],
    { stdio: "ignore" },
  );
  run(
    root,
    "fetch",
    "-q",
    "origin",
    "+refs/heads/stack-c:refs/remotes/origin/stack-c",
    "+refs/heads/stack-b:refs/remotes/origin/stack-b",
  );
  run(root, "branch", "-q", "stack-c", "origin/stack-c");
  return { root, git: (...args: string[]) => run(root, ...args) };
}

const get = (route: string, query: Record<string, string>) =>
  new Request(
    `http://127.0.0.1:4460/api/${route}?${new URLSearchParams(query)}`,
  );

async function diffPaths(query: Record<string, string>): Promise<string[]> {
  const res = await diff.GET(get("diff", query));
  assert.equal(res.status, 200);
  const body = (await res.json()) as DiffResponse;
  return body.files.map((f) => f.path).sort();
}

async function sessionOf(root: string, ref: string): Promise<SessionResponse> {
  const res = await session.GET(get("session", { repo: root, ref }));
  assert.equal(res.status, 200);
  return (await res.json()) as SessionResponse;
}

const sorted = (lines: string) => lines.split("\n").filter(Boolean).sort();

test("the whole stack runs from where the stack forked from main, and the branch view from stack-b", async () => {
  const { root, git } = fullClone("main");
  const repo = await resolveRepo(root, "stack-c");

  const branch = await viewRange(repo, BRANCH_REV);
  const stack = await viewRange(repo, STACK_REV);
  assert.equal(branch?.base, git("merge-base", "origin/stack-b", "stack-c"));
  assert.equal(stack?.base, git("merge-base", "origin/main", "stack-c"));
  assert.equal(stack?.head, git("rev-parse", "stack-c"));
});

test("the whole stack's diff has every branch's files, and the branch view keeps its own", async () => {
  const { root, git } = fullClone("main");
  const view = { repo: root, ref: "stack-c" };

  const whole = await diffPaths({ ...view, rev: STACK_REV });
  assert.deepEqual(whole, sorted(git("diff", "--name-only", "main...stack-c")));
  assert.deepEqual(whole, [
    "db/schema.sql",
    "src/a1.ts",
    "src/a2.ts",
    "src/b1.ts",
    "src/b2.ts",
    "src/c1.ts",
  ]);
  assert.deepEqual(await diffPaths({ ...view, rev: BRANCH_REV }), [
    "src/c1.ts",
  ]);
});

test("the session has the stack's numbers on a stacked PR, and asks nothing more on one based on main", async () => {
  const { root } = fullClone("main");

  const stacked = await sessionOf(root, "stack-c");
  assert.equal(stacked.github.stackStart, "main");
  assert.equal(stacked.stackDiff?.label, "vs main");
  assert.equal(stacked.stackDiff?.commits, 3);
  assert.equal(stacked.stackDiff?.filesChanged, 6);
  assert.equal(stacked.branchDiff?.label, "vs stack-b");

  writeFileSync(path.join(ghDir, "gh.log"), "");
  const bottom = await sessionOf(root, "stack-a");
  assert.equal(bottom.github.pr?.number, 1);
  assert.equal(bottom.github.stackStart, null);
  assert.equal(bottom.stackDiff, null);
  assert.doesNotMatch(ghLog(), /pullRequests\(states/);
});

test("a stack whose start the clone hasn't got has no stack diff, and the branch view still works", async () => {
  const { root } = cloneWithoutStart();
  const view = { repo: root, ref: "stack-c" };

  const opened = await sessionOf(root, "stack-c");
  assert.equal(opened.github.stackStart, "epic");
  assert.equal(opened.stackDiff, null);
  assert.equal(
    (await diff.GET(get("diff", { ...view, rev: STACK_REV }))).status,
    404,
  );
  assert.deepEqual(await diffPaths({ ...view, rev: BRANCH_REV }), [
    "src/c1.ts",
  ]);
});

test("fetching the branch with the stack's start as its base brings the start in as origin's, and the session then has the stack", async () => {
  const { root, git } = cloneWithoutStart();
  assert.equal((await sessionOf(root, "stack-c")).stackDiff, null);

  const res = await fetchRoute.POST(
    new Request("http://127.0.0.1:4460/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: root, branch: "stack-c", base: "epic" }),
    }),
  );
  assert.equal(res.status, 200);

  assert.ok(
    git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/epic"),
  );
  assert.equal(git("for-each-ref", "refs/heads/epic"), "");

  const fetched = await sessionOf(root, "stack-c");
  assert.equal(fetched.stackDiff?.label, "vs epic");
  assert.deepEqual(
    await diffPaths({ repo: root, ref: "stack-c", rev: STACK_REV }),
    sorted(git("diff", "--name-only", "origin/epic...stack-c")),
  );
});

test("the map and data model read the whole stack's range", async () => {
  const { root } = fullClone("main");
  const view = { repo: root, ref: "stack-c", rev: STACK_REV };

  const mapRes = await map.GET(get("map", view));
  assert.equal(mapRes.status, 200);
  const read = (await mapRes.json()) as MapResponse;
  assert.deepEqual(Object.keys(read.fileComponents).sort(), [
    "src/a1.ts",
    "src/a2.ts",
    "src/b1.ts",
    "src/b2.ts",
    "src/c1.ts",
  ]);

  const dataRes = await data.GET(get("data", view));
  assert.equal(dataRes.status, 200);
  const model = (await dataRes.json()) as DataResponse;
  assert.deepEqual(
    model.entities
      .filter((e) => e.state !== "same")
      .map((e) => [e.state, e.file]),
    [["added", "db/schema.sql"]],
  );
});
