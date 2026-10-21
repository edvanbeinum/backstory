import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GET } from "../app/api/session/route";
import type { SessionResponse } from "../lib/types";
import {
  githubApiStandIn,
  quietLoginShell,
  SECURITY,
  standIns,
  type ApiAnswer,
  type ApiCall,
} from "./standins";

quietLoginShell();
// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repo it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-session-"),
);

/** A repo on branch `feature`, one commit past `main`, whose origin is `acme/app`. */
function repoOnGitHub(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-session-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(path.join(root, "a.ts"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "First");
  git("checkout", "-qb", "feature");
  writeFileSync(path.join(root, "a.ts"), "one\ntwo\nthree\n");
  git("commit", "-qam", "Second");
  git("remote", "add", "origin", "git@github.com:acme/app.git");
  return root;
}

const PR = {
  number: 7,
  title: "Add things",
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature",
  author: { login: "author" },
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
};

const thread = (id: string, line: number, createdAt: string) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: "a.ts",
  line,
  originalLine: line,
  startLine: null,
  diffSide: "RIGHT",
  comments: {
    nodes: [
      {
        id: `${id}-c`,
        databaseId: 1,
        body: `About line ${line}`,
        createdAt,
        url: `https://github.com/acme/app/pull/7#${id}`,
        diffHunk: "@@ -1 +1,3 @@",
        author: { login: "reviewer", avatarUrl: null },
      },
    ],
  },
});

/** Two threads, the newer one first, as GitHub may return them. */
const github = (call: ApiCall): ApiAnswer => ({
  json: call.query.includes("pullRequests(headRefName")
    ? { data: { repository: { pullRequests: { nodes: [PR] } } } }
    : {
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: [] },
              reviewThreads: {
                nodes: [
                  thread("newer", 3, "2026-10-02T00:00:00Z"),
                  thread("older", 2, "2026-10-01T00:00:00Z"),
                ],
              },
            },
          },
        },
      },
});

test("the session lists the PR's threads oldest first, with their comments and lines, and nothing of yours attached", async () => {
  const root = repoOnGitHub();
  const dir = standIns({
    security: SECURITY,
    gh: 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4',
  });
  writeFileSync(path.join(dir, "keychain"), "gho_saved1");
  const api = await githubApiStandIn(github);
  const saved = {
    path: process.env.PATH,
    api: process.env.BACKSTORY_GITHUB_API,
  };
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.BACKSTORY_GITHUB_API = api.url;
  try {
    const res = await GET(
      new Request(
        `http://127.0.0.1:4460/api/session?repo=${encodeURIComponent(root)}&fresh=1`,
      ),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as SessionResponse;

    assert.equal(body.github.pr?.number, 7);
    assert.deepEqual(
      body.github.threads.map((t) => [
        t.id,
        t.path,
        t.line,
        t.comments.map((c) => c.body),
      ]),
      [
        ["older", "a.ts", 2, ["About line 2"]],
        ["newer", "a.ts", 3, ["About line 3"]],
      ],
    );
    for (const t of body.github.threads) assert.equal("response" in t, false);
  } finally {
    process.env.PATH = saved.path;
    if (saved.api === undefined) delete process.env.BACKSTORY_GITHUB_API;
    else process.env.BACKSTORY_GITHUB_API = saved.api;
    await api.close();
  }
});
