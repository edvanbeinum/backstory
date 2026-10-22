import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import * as data from "../app/api/data/route";
import * as diff from "../app/api/diff/route";
import * as file from "../app/api/file/route";
import * as flows from "../app/api/flows/route";
import * as map from "../app/api/map/route";
import * as snippet from "../app/api/snippet/route";
import type { DataResponse } from "../lib/data/types";
import { onFlowsChange, startFlows } from "../lib/flows/cache";
import type { FlowsStatus } from "../lib/flows/types";
import { resolveBase, resolveRepo } from "../lib/git";
import type { MapResponse } from "../lib/map";
import type { Snippet } from "../lib/snippet";
import type { DiffResponse, FileViewResponse } from "../lib/types";
import {
  githubApiStandIn,
  quietLoginShell,
  SECURITY,
  standIns,
  type ApiCall,
  type ApiAnswer,
} from "./standins";

quietLoginShell();
// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-ref-view-"),
);

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

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
 * A stack of two branches off `main`, with `main` checked out and one commit
 * past where the stack forked. `stack-a` adds two files, and `stack-b` adds
 * two more and a table to the schema.
 */
function stack(opts: { remote?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-ref-view-repo-"));
  temps.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
    }
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  if (opts.remote)
    git("remote", "add", "origin", "git@github.com:acme/app.git");
  const fork = commit(
    {
      "src/base.ts": "base\n",
      "architecture/workspace.dsl": MODEL,
      "db/schema.sql": THINGS,
    },
    "Start",
  );
  git("update-ref", "refs/remotes/origin/main", fork);
  git("checkout", "-qb", "stack-a");
  const a = commit({ "src/a1.ts": "a1\n", "src/a2.ts": "a2\n" }, "Stack A");
  git("checkout", "-qb", "stack-b");
  const b = commit(
    {
      "src/b1.ts": "b1\nmore b1\n",
      "src/b2.ts": "b2\n",
      "db/schema.sql": `${THINGS}CREATE TABLE stacks (id integer PRIMARY KEY);\n`,
    },
    "Stack B",
  );
  git("checkout", "-q", "main");
  commit({ "src/main-only.ts": "main\n" }, "Main moves on");
  return { root, git, fork, a, b };
}

const PR = {
  number: 9,
  title: "Stack B",
  url: "https://github.com/acme/app/pull/9",
  state: "OPEN",
  isDraft: false,
  baseRefName: "stack-a",
  headRefName: "stack-b",
  author: { login: "author" },
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
};

/** GitHub with one PR, `stack-b`'s onto `stack-a`, and no threads. */
const github = (call: ApiCall): ApiAnswer => ({
  json: call.query.includes("pullRequests(headRefName")
    ? {
        data: {
          repository: {
            pullRequests: {
              nodes: call.variables.branch === "stack-b" ? [PR] : [],
            },
          },
        },
      }
    : {
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] },
            },
          },
        },
      },
});

let closeApi: () => Promise<void> = async () => {};
const saved = { path: process.env.PATH, api: process.env.BACKSTORY_GITHUB_API };
before(async () => {
  const dir = standIns({
    security: SECURITY,
    gh: 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4',
  });
  temps.push(dir);
  writeFileSync(path.join(dir, "keychain"), "gho_saved1");
  const api = await githubApiStandIn(github);
  closeApi = api.close;
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.BACKSTORY_GITHUB_API = api.url;
});
after(async () => {
  process.env.PATH = saved.path;
  if (saved.api === undefined) delete process.env.BACKSTORY_GITHUB_API;
  else process.env.BACKSTORY_GITHUB_API = saved.api;
  await closeApi();
});

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

const sorted = (lines: string) => lines.split("\n").filter(Boolean).sort();

test("a branch opened by ref diffs its own changes against its PR's base, not the checkout's", async () => {
  const { root, git } = stack({ remote: true });
  const own = await diffPaths({ repo: root, ref: "stack-b", rev: "branch" });
  assert.deepEqual(own, ["db/schema.sql", "src/b1.ts", "src/b2.ts"]);
  assert.deepEqual(
    own,
    sorted(git("diff", "--name-only", "stack-a...stack-b")),
  );
  assert.deepEqual(await diffPaths({ repo: root, rev: "branch" }), [
    "src/main-only.ts",
  ]);
});

test("a branch opened by ref with no PR diffs from the default branch's fork point", async () => {
  const { root } = stack();
  assert.deepEqual(
    await diffPaths({ repo: root, ref: "stack-b", rev: "branch" }),
    ["db/schema.sql", "src/a1.ts", "src/a2.ts", "src/b1.ts", "src/b2.ts"],
  );
});

test("a branch opened by ref that is named like a folder still diffs", async () => {
  const { root, git } = stack();
  git("branch", "src", "stack-b");
  assert.deepEqual(await diffPaths({ repo: root, ref: "src", rev: "branch" }), [
    "db/schema.sql",
    "src/a1.ts",
    "src/a2.ts",
    "src/b1.ts",
    "src/b2.ts",
  ]);
});

test("View file and a step's code read the branch opened by ref", async () => {
  const { root } = stack();
  const view = { repo: root, ref: "stack-b", rev: "branch", path: "src/b1.ts" };

  const whole = await file.GET(get("file", view));
  assert.equal(whole.status, 200);
  const fileBody = (await whole.json()) as FileViewResponse;
  assert.deepEqual(
    fileBody.file.hunks.flatMap((h) => h.lines.map((l) => l.content)),
    ["b1", "more b1"],
  );
  const { ref: _, ...checkout } = view;
  assert.equal((await file.GET(get("file", checkout))).status, 404);

  const step = await snippet.GET(
    get("snippet", { ...view, line: "2", side: "new" }),
  );
  assert.equal(step.status, 200);
  const stepBody = (await step.json()) as Snippet;
  assert.equal(
    stepBody.file.hunks[0].lines[stepBody.target].content,
    "more b1",
  );
  assert.equal(
    (await snippet.GET(get("snippet", { ...checkout, line: "2", side: "new" })))
      .status,
    404,
  );
});

test("the map and data model of a branch opened by ref are read from its commits", async () => {
  const { root } = stack({ remote: true });
  const view = { repo: root, ref: "stack-b", rev: "branch" };

  const own = (await (await map.GET(get("map", view))).json()) as MapResponse;
  assert.deepEqual(Object.keys(own.fileComponents).sort(), [
    "src/b1.ts",
    "src/b2.ts",
  ]);
  const checkout = (await (
    await map.GET(get("map", { repo: root, rev: "branch" }))
  ).json()) as MapResponse;
  assert.deepEqual(Object.keys(checkout.fileComponents), ["src/main-only.ts"]);

  const model = (await (
    await data.GET(get("data", view))
  ).json()) as DataResponse;
  const changed = (d: DataResponse) =>
    d.entities.filter((e) => e.state !== "same").map((e) => [e.state, e.file]);
  assert.deepEqual(changed(model), [["added", "db/schema.sql"]]);
  const checkoutModel = (await (
    await data.GET(get("data", { repo: root, rev: "branch" }))
  ).json()) as DataResponse;
  assert.equal(checkoutModel.status, "ok");
  assert.deepEqual(changed(checkoutModel), []);
});

test("the flows of a branch opened by ref are the ones traced for its commits", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-ref-view-flows-"));
  temps.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "--allow-empty", "-qm", "Start");
  const fork = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", fork);
  git("checkout", "-qb", "stack-b");
  // Only `architecture/` changes, which is never app code, so the run below
  // finishes with no flows and never calls the AI provider.
  mkdirSync(path.join(root, "architecture"));
  writeFileSync(path.join(root, "architecture/notes.md"), "model\n");
  git("add", "-A");
  git("commit", "-qm", "Describe the model");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("commit", "--allow-empty", "-qm", "Main moves on");

  const done = new Promise<void>((resolve) => {
    const off = onFlowsChange((changed) => {
      if (changed !== root) return;
      off();
      resolve();
    });
  });
  await startFlows(
    { root, base: fork, head },
    { status: async () => "ready" as const },
  );
  await done;

  const status = async (query: Record<string, string>) => {
    const res = await flows.GET(get("flows", query));
    assert.ok(res);
    return ((await res.json()) as FlowsStatus).status;
  };
  assert.equal(
    await status({ repo: root, ref: "stack-b", rev: "branch" }),
    "ready",
  );
  assert.equal(await status({ repo: root, rev: "branch" }), "idle");
});

test("a branch opened by ref measures its upstream from its own tip, not the checkout's", async () => {
  const { root, git, fork, b } = stack({ remote: true });
  git("update-ref", "refs/remotes/origin/stack-b", b);
  git("config", "branch.stack-b.remote", "origin");
  git("config", "branch.stack-b.merge", "refs/heads/stack-b");

  const base = await resolveBase(await resolveRepo(root, "stack-b"));
  assert.equal(base.reason, "upstream");
  assert.equal(base.sha, b);
  assert.notEqual(base.sha, fork);
});

test("a branch opened by ref has no uncommitted work, even when the checkout has some", async () => {
  const { root } = stack();
  writeFileSync(path.join(root, "scratch.ts"), "export const wip = 1;\n");
  assert.deepEqual(
    await diffPaths({ repo: root, ref: "stack-b", rev: "working" }),
    [],
  );
  assert.deepEqual(await diffPaths({ repo: root, rev: "working" }), [
    "scratch.ts",
  ]);
});

test("a ref that starts with a dash is refused before it reaches git", async () => {
  const { root } = stack();
  const out = path.join(root, "written-by-git");
  const res = await diff.GET(
    get("diff", { repo: root, ref: `--output=${out}`, rev: "branch" }),
  );
  assert.equal(res.status, 500);
  assert.equal(existsSync(out), false);
});
