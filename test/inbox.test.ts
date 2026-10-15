import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pickPullRequest } from "../lib/github";
import { buildInbox } from "../lib/inbox";
import { countProgress } from "../lib/progress";
import type { ResponseRecord } from "../lib/responses";
import {
  githubApiStandIn,
  quietLoginShell,
  SECURITY,
  standIns,
  type ApiAnswer,
  type ApiCall,
} from "./standins";

quietLoginShell();
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-inbox-"),
);

const record = (over: Partial<ResponseRecord> = {}): ResponseRecord => ({
  done: false,
  doneAt: null,
  reply: null,
  commits: [],
  ...over,
});

/**
 * Matching a PR on head branch alone reaches into forks. These five are the
 * real ones `headRefName: "trunk"` returns for cli/cli — every contributor who
 * pushed a branch called trunk to their own fork. Without filtering, opening a
 * worktree on `main` would attach a stranger's PR and show their review
 * comments as your checklist.
 */
const CLI_TRUNK = [
  {
    number: 14034,
    state: "CLOSED",
    isCrossRepository: true,
    headRepositoryOwner: { login: "flynnjustin24" },
  },
  {
    number: 13940,
    state: "MERGED",
    isCrossRepository: true,
    headRepositoryOwner: { login: "pstoeckle" },
  },
  {
    number: 13929,
    state: "CLOSED",
    isCrossRepository: true,
    headRepositoryOwner: { login: "SkyMeilin" },
  },
  {
    number: 13797,
    state: "CLOSED",
    isCrossRepository: true,
    headRepositoryOwner: { login: "dx-nadee" },
  },
  {
    number: 13607,
    state: "CLOSED",
    isCrossRepository: true,
    headRepositoryOwner: { login: "Harsith2k5" },
  },
];

test("a same-repo PR always beats a fork's", () => {
  const mine = {
    number: 12,
    state: "OPEN",
    isCrossRepository: false,
    headRepositoryOwner: { login: "cli" },
  };
  assert.equal(pickPullRequest([...CLI_TRUNK, mine], "cli")?.number, 12);
});

test("an open PR beats a merged one, and the newest breaks the tie", () => {
  const rows = [
    {
      number: 3,
      state: "MERGED",
      isCrossRepository: false,
      headRepositoryOwner: null,
    },
    {
      number: 4,
      state: "OPEN",
      isCrossRepository: false,
      headRepositoryOwner: null,
    },
    {
      number: 9,
      state: "CLOSED",
      isCrossRepository: false,
      headRepositoryOwner: null,
    },
  ];
  assert.equal(pickPullRequest(rows, "me")?.number, 4);
  assert.equal(
    pickPullRequest(
      rows.filter((r) => r.state !== "OPEN"),
      "me",
    )?.number,
    9,
  );
});

test("forks are a last resort, not a hard exclusion", () => {
  // Nothing local matches, so showing the fork's PR beats showing nothing —
  // and an older `gh` that omits the field shouldn't blank the screen.
  // None of these are open, so the newest wins.
  assert.equal(pickPullRequest(CLI_TRUNK, "cli")?.number, 14034);
  const noField = [{ number: 7, state: "OPEN" }];
  assert.equal(pickPullRequest(noField, "cli")?.number, 7);
});

test("nothing to pick from is null, not a throw", () => {
  assert.equal(pickPullRequest([], "cli"), null);
});

test("progress counts threads and review bodies alike", () => {
  const responses = {
    t1: record({ done: true }),
    t2: record({ reply: "drafted, not ticked" }),
    r1: record({ done: true }),
  };
  const progress = countProgress(["t1", "t2", "t3", "r1"], responses);
  assert.deepEqual(progress, { done: 2, total: 4, truncated: false });
});

test("a tick on a thread GitHub has since deleted can't inflate the count", () => {
  // Otherwise `done` could climb past `total` and the meter would overflow.
  const responses = {
    gone: record({ done: true }),
    t1: record({ done: true }),
  };
  const progress = countProgress(["t1"], responses);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 1);
});

test("more threads than one page returned is reported, not hidden", () => {
  const progress = countProgress(
    ["t1"],
    { t1: record({ done: true }) },
    {
      reportedTotal: 140,
    },
  );
  assert.equal(progress.total, 140);
  assert.equal(progress.truncated, true);
});

test("neither a linked commit nor a draft counts as handled", () => {
  // The whole point: only the tick means done.
  const responses = {
    t1: record({ commits: [{ sha: "abc1234", patchId: null }] }),
    t2: record({ reply: "Addressed in abc1234" }),
  };
  assert.equal(countProgress(["t1", "t2"], responses).done, 0);
});

/** A repo on branch `feature` whose origin is `acme/<name>` on github.com. */
function repoOnGitHub(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-inbox-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "feature");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(path.join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "First");
  git("remote", "add", "origin", `git@github.com:acme/${name}.git`);
  return root;
}

const INBOX_PR = {
  number: 7,
  title: "Add things",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/app/pull/7",
  updatedAt: "2026-10-01T00:00:00Z",
  baseRefName: "main",
  isCrossRepository: false,
  headRepositoryOwner: { login: "acme" },
  reviewThreads: {
    totalCount: 2,
    nodes: [
      { id: "t1", isResolved: false },
      { id: "t2", isResolved: true },
    ],
  },
  reviews: { nodes: [{ id: "r1", body: "Hi" }] },
};

/** Answers each branch alias, with the PR for `feature`. */
const inboxApi = (call: ApiCall): ApiAnswer => ({
  json: {
    data: {
      repository: Object.fromEntries(
        Object.entries(call.variables)
          .filter(([key]) => /^b\d+$/.test(key))
          .map(([key, branch]) => [
            `w${key.slice(1)}`,
            { nodes: branch === "feature" ? [INBOX_PR] : [] },
          ]),
      ),
    },
  },
});

/** The inbox on a machine with a saved token, no `gh`, and `answer` for GitHub. */
async function inboxWithToken(
  root: string,
  answer: (call: ApiCall) => ApiAnswer,
) {
  const dir = standIns({ security: SECURITY });
  writeFileSync(path.join(dir, "keychain"), "gho_saved1");
  const api = await githubApiStandIn(answer);
  const saved = {
    path: process.env.PATH,
    api: process.env.BACKSTORY_GITHUB_API,
  };
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  process.env.BACKSTORY_GITHUB_API = api.url;
  try {
    return { inbox: await buildInbox([root]), calls: api.calls };
  } finally {
    process.env.PATH = saved.path;
    if (saved.api === undefined) delete process.env.BACKSTORY_GITHUB_API;
    else process.env.BACKSTORY_GITHUB_API = saved.api;
    await api.close();
  }
}

test("with a saved token and no gh, the inbox counts come from GitHub's API", async () => {
  const { inbox, calls } = await inboxWithToken(repoOnGitHub("app"), inboxApi);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer gho_saved1");
  assert.equal(inbox.repos[0].unavailable, null);
  assert.equal(inbox.repos[0].connect, false);
  const row = inbox.rows.find((r) => r.branch === "feature");
  assert.equal(row?.pr?.number, 7);
  assert.equal(row?.pr?.unresolved, 1);
  assert.deepEqual(row?.progress, { done: 0, total: 3, truncated: false });
});

test("with a refused token and no gh, the repo asks to Connect GitHub and still lists its rows", async () => {
  const { inbox } = await inboxWithToken(repoOnGitHub("other"), () => ({
    status: 401,
  }));

  assert.equal(inbox.repos[0].connect, true);
  assert.match(inbox.repos[0].unavailable ?? "", /Connect GitHub/);
  assert.deepEqual(
    inbox.rows.map((r) => [r.branch, r.pr]),
    [["feature", null]],
  );
});
