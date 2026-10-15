import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadGitHubData } from "../lib/github";
import { parseRemote } from "../lib/git";
import type { RepoInfo } from "../lib/types";
import {
  githubApiStandIn,
  quietLoginShell,
  SECURITY,
  standIns,
  type ApiAnswer,
  type ApiCall,
} from "./standins";

quietLoginShell();

const TOKEN = "gho_standInToken123";
const CONNECT = "Connect GitHub to see this pull request's review comments.";

const PR = {
  number: 7,
  title: "Add things",
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature",
  author: { login: "ed" },
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
};

const PULL_REQUEST = {
  reviews: {
    nodes: [
      {
        id: "r1",
        body: "Looks good overall",
        state: "COMMENTED",
        url: "https://github.com/acme/app/pull/7#r1",
        createdAt: "2026-10-01T00:00:00Z",
        author: { login: "rev", avatarUrl: null },
      },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        id: "t1",
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        line: 3,
        originalLine: 3,
        startLine: null,
        diffSide: "RIGHT",
        comments: {
          nodes: [
            {
              id: "c1",
              databaseId: 1,
              body: "Why?",
              createdAt: "2026-10-01T00:00:00Z",
              url: "https://github.com/acme/app/pull/7#c1",
              diffHunk: "@@ -1 +1 @@",
              author: { login: "rev", avatarUrl: null },
            },
          ],
        },
      },
    ],
  },
};

const PRS_JSON = { data: { repository: { pullRequests: { nodes: [PR] } } } };
const THREADS_JSON = { data: { repository: { pullRequest: PULL_REQUEST } } };

const github = (call: ApiCall): ApiAnswer => ({
  json: call.query.includes("pullRequests(headRefName")
    ? PRS_JSON
    : THREADS_JSON,
});

/** A `gh` that answers either query from files beside it, logging its argv. */
const GH = `PATH=/usr/bin:/bin
dir="\${0%/*}"
echo "$*" >> "$dir/gh.log"
case "$*" in
  *"pullRequests(headRefName"*) cat "$dir/prs.json" ;;
  *) cat "$dir/threads.json" ;;
esac`;

function machine(opts: { gh?: boolean; token?: boolean }) {
  const dir = standIns({ security: SECURITY, ...(opts.gh && { gh: GH }) });
  writeFileSync(path.join(dir, "prs.json"), JSON.stringify(PRS_JSON));
  writeFileSync(path.join(dir, "threads.json"), JSON.stringify(THREADS_JSON));
  if (opts.token) writeFileSync(path.join(dir, "keychain"), TOKEN);
  const read = (name: string) =>
    existsSync(path.join(dir, name))
      ? readFileSync(path.join(dir, name), "utf8")
      : "";
  return {
    dir,
    keychain: () => read("keychain"),
    ghLog: () => read("gh.log"),
    securityLog: () => read("security.log"),
  };
}

const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({
  input: os.tmpdir(),
  root: os.tmpdir(),
  branch: "feature",
  checkedOut: "feature",
  ref: null,
  tip: "HEAD",
  detached: false,
  remoteUrl: "git@github.com:acme/app.git",
  host: "github.com",
  owner: "acme",
  name: "app",
  defaultBranch: "main",
  ...over,
});

async function load(
  on: ReturnType<typeof machine>,
  answer: (call: ApiCall) => ApiAnswer,
  info: RepoInfo = repo(),
) {
  const api = await githubApiStandIn(answer);
  const saved = {
    path: process.env.PATH,
    api: process.env.BACKSTORY_GITHUB_API,
  };
  process.env.PATH = on.dir;
  process.env.BACKSTORY_GITHUB_API = api.url;
  try {
    return { data: await loadGitHubData(info), calls: api.calls };
  } finally {
    process.env.PATH = saved.path;
    if (saved.api === undefined) delete process.env.BACKSTORY_GITHUB_API;
    else process.env.BACKSTORY_GITHUB_API = saved.api;
    await api.close();
  }
}

test("with a saved token and no gh, the PR, its threads and reviews come from GitHub's API", async () => {
  const on = machine({ token: true });
  const { data, calls } = await load(on, github);

  assert.equal(data.unavailable, null);
  assert.equal(data.connect, false);
  assert.equal(data.pr?.number, 7);
  assert.deepEqual(
    data.threads.map((t) => [t.id, t.comments[0].body]),
    [["t1", "Why?"]],
  );
  assert.deepEqual(
    data.reviews.map((r) => r.id),
    ["r1"],
  );
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0].variables, {
    owner: "acme",
    name: "app",
    branch: "feature",
  });
  assert.deepEqual(calls[1].variables, {
    owner: "acme",
    name: "app",
    number: 7,
  });
  assert.ok(!on.securityLog().includes(TOKEN));
});

test("with no token and a signed-in gh, the same data comes through gh api graphql, with no pr list", async () => {
  const on = machine({ gh: true });
  const { data, calls } = await load(on, github);

  assert.equal(data.unavailable, null);
  assert.equal(data.pr?.number, 7);
  assert.equal(data.threads.length, 1);
  assert.equal(data.reviews.length, 1);
  assert.equal(calls.length, 0);
  assert.match(on.ghLog(), /^api graphql -f query=/m);
  assert.match(on.ghLog(), /-f branch=feature/);
  assert.match(on.ghLog(), /-F number=7/);
  assert.doesNotMatch(on.ghLog(), /pr list/);
});

test("a revoked token is forgotten and the read tried again through gh", async () => {
  const on = machine({ gh: true, token: true });
  const { data, calls } = await load(on, () => ({ status: 401 }));

  assert.equal(data.unavailable, null);
  assert.equal(data.pr?.number, 7);
  assert.equal(calls.length, 1);
  assert.equal(on.keychain(), "");
  assert.ok(on.ghLog().length > 0);
  assert.ok(!on.ghLog().includes(TOKEN));
  assert.ok(!on.securityLog().includes(TOKEN));
});

test("a revoked token with no gh asks to Connect GitHub, without throwing", async () => {
  const on = machine({ token: true });
  const { data } = await load(on, () => ({ status: 401 }));

  assert.equal(data.unavailable, CONNECT);
  assert.equal(data.connect, true);
  assert.equal(data.pr, null);
  assert.equal(on.keychain(), "");
});

test("a token missing the repo scope counts as revoked", async () => {
  const on = machine({ token: true });
  const { data } = await load(on, (call) => ({
    ...github(call),
    headers: { "x-oauth-scopes": "read:user" },
  }));

  assert.equal(data.unavailable, CONNECT);
  assert.equal(data.connect, true);
  assert.equal(on.keychain(), "");
});

test("no gh and no token asks to Connect GitHub too", async () => {
  const { data } = await load(machine({}), github);
  assert.equal(data.unavailable, CONNECT);
  assert.equal(data.connect, true);
});

test("an Enterprise remote never gets the github.com token, and uses gh", async () => {
  const on = machine({ gh: true, token: true });
  const { data, calls } = await load(
    on,
    github,
    repo({ host: "ghe.example.com" }),
  );

  assert.equal(calls.length, 0);
  assert.equal(data.pr?.number, 7);
  assert.ok(on.ghLog().length > 0);
  assert.equal(on.keychain(), TOKEN);
});

test("a repository GitHub can't find on the token names organisation approval", async () => {
  const on = machine({ token: true });
  const { data } = await load(on, () => ({
    json: {
      errors: [
        {
          message:
            "Could not resolve to a Repository with the name 'acme/app'.",
        },
      ],
    },
  }));

  assert.match(data.unavailable ?? "", /organisation may need to approve/);
  assert.equal(data.connect, false);
  assert.equal(on.keychain(), TOKEN);
});

test("the remote's host comes out of every spelling, so the token knows where it may go", () => {
  assert.equal(parseRemote("git@github.com:acme/app.git").host, "github.com");
  assert.equal(parseRemote("https://github.com/acme/app").host, "github.com");
  assert.equal(parseRemote("git@github-work:acme/app.git").host, "github-work");
  assert.equal(
    parseRemote("ssh://git@ghe.example.com/acme/app.git").host,
    "ghe.example.com",
  );
  assert.equal(parseRemote(null).host, null);
});
