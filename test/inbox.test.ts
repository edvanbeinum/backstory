import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pickPullRequest } from "../lib/github";
import { buildInbox } from "../lib/inbox";
import { markLooked } from "../lib/looked";
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
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-inbox-"),
);

/**
 * Matching a PR on head branch alone reaches into forks. These five are the
 * real ones `headRefName: "trunk"` returns for cli/cli — every contributor who
 * pushed a branch called trunk to their own fork. Without filtering, opening a
 * worktree on `main` would attach a stranger's PR and show their review
 * comments as yours.
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
};

/** Answers each branch alias from `byBranch`, by default the PR for `feature`. */
const inboxApi =
  (byBranch: Record<string, object[]> = { feature: [INBOX_PR] }) =>
  (call: ApiCall): ApiAnswer => ({
    json: {
      data: {
        repository: Object.fromEntries(
          Object.entries(call.variables)
            .filter(([key]) => /^b\d+$/.test(key))
            .map(([key, branch]) => [
              `w${key.slice(1)}`,
              { nodes: byBranch[branch as string] ?? [] },
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
  // A signed-out `gh` ahead of /usr/bin, where CI's runners have a real one
  const dir = standIns({
    security: SECURITY,
    gh: 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4',
  });
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

test("with a saved token and no gh, the inbox's pull requests come from GitHub's API", async () => {
  const { inbox, calls } = await inboxWithToken(
    repoOnGitHub("app"),
    inboxApi(),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer gho_saved1");
  assert.equal(inbox.repos[0].unavailable, null);
  assert.equal(inbox.repos[0].connect, false);
  const row = inbox.rows.find((r) => r.branch === "feature");
  assert.equal(row?.pr?.number, 7);
  assert.equal("unresolved" in (row?.pr ?? {}), false);
});

/**
 * A repo on `main` with one commit, its origin `acme/<name>` on github.com
 * when named, and helpers to commit and to check out a new branch beside it.
 */
function repoOnMain(name: string | null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-inbox-main-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  if (name) {
    git(root, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  }
  const commit = (
    cwd: string,
    files: Record<string, string>,
    at = "2026-10-01T00:00:00Z",
  ) => {
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(path.join(cwd, file), text);
    }
    git(cwd, "add", "-A");
    execFileSync("git", ["-C", cwd, "commit", "-qm", "Change"], {
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    });
    return git(cwd, "rev-parse", "HEAD");
  };
  const worktree = (branch: string, from = "main") => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "backstory-inbox-wt-"));
    git(root, "worktree", "add", "-q", "-b", branch, dir, from);
    return dir;
  };
  commit(root, { "a.txt": "a\n" });
  const commonDir = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { root, commonDir, commit, worktree };
}

test("a branch reads as changed until you look at it, and again after a new commit", async () => {
  const repo = repoOnMain(null);
  const one = repo.worktree("one");
  const two = repo.worktree("two");
  const tip = repo.commit(one, { "one.txt": "1\n" });
  repo.commit(two, { "two.txt": "2\n" });
  const changed = async () =>
    Object.fromEntries(
      (await buildInbox([repo.root])).rows.map((r) => [r.branch, r.changed]),
    );

  assert.deepEqual(await changed(), { main: false, one: true, two: true });

  markLooked(repo.commonDir, "one", tip, 5);
  assert.deepEqual(await changed(), { main: false, one: false, two: true });

  repo.commit(one, { "one.txt": "1\n1\n" });
  assert.deepEqual(await changed(), { main: false, one: true, two: true });
});

test("the main checkout on the default branch has nothing to count and never reads as changed", async () => {
  const repo = repoOnMain(null);
  repo.commit(repo.root, { "b.txt": "b\n" });

  const main = (await buildInbox([repo.root])).rows.find(
    (r) => r.branch === "main",
  );
  assert.equal(main?.isMain, true);
  assert.equal(main?.changes, null);
  assert.equal(main?.changed, false);
});

test("a branch counts its commits, files and lines from where it left main, not main's own later work", async () => {
  const repo = repoOnMain(null);
  const dir = repo.worktree("feature");
  repo.commit(dir, { "x.txt": "1\n2\n", "y.txt": "y\n" });
  repo.commit(dir, { "a.txt": "b\n" });
  repo.commit(repo.root, { "later.txt": "on main\n" });

  const row = (await buildInbox([repo.root])).rows.find(
    (r) => r.branch === "feature",
  );
  assert.deepEqual(row?.changes, {
    commits: 2,
    files: 3,
    additions: 4,
    deletions: 1,
  });
});

test("a stacked branch counts from the branch its PR targets, not main", async () => {
  const repo = repoOnMain("stacked");
  const bottom = repo.worktree("bottom");
  repo.commit(bottom, { "b.txt": "b\n" });
  const top = repo.worktree("top", "bottom");
  repo.commit(top, { "t.txt": "t\n" });

  const { inbox } = await inboxWithToken(
    repo.root,
    inboxApi({ top: [{ ...INBOX_PR, number: 12, baseRefName: "bottom" }] }),
  );
  const changes = (branch: string) =>
    inbox.rows.find((r) => r.branch === branch)?.changes;
  assert.deepEqual(changes("top"), {
    commits: 1,
    files: 1,
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(changes("bottom"), {
    commits: 1,
    files: 1,
    additions: 1,
    deletions: 0,
  });
});

test("changed rows come first, then newest commit first, and merged PRs last", async () => {
  const repo = repoOnMain("ordered");
  const early = repo.worktree("early");
  repo.commit(early, { "e.txt": "e\n" }, "2026-10-02T00:00:00Z");
  const seen = repo.worktree("seen");
  const tip = repo.commit(seen, { "s.txt": "s\n" }, "2026-10-04T00:00:00Z");
  const merged = repo.worktree("merged");
  repo.commit(merged, { "m.txt": "m\n" }, "2026-10-05T00:00:00Z");
  const late = repo.worktree("late");
  repo.commit(late, { "l.txt": "l\n" }, "2026-10-03T00:00:00Z");
  markLooked(repo.commonDir, "seen", tip);

  const { inbox } = await inboxWithToken(
    repo.root,
    inboxApi({
      seen: [{ ...INBOX_PR, number: 8 }],
      merged: [{ ...INBOX_PR, number: 9, state: "MERGED" }],
    }),
  );

  assert.deepEqual(
    inbox.rows.map((r) => [r.branch, r.changed]),
    [
      ["late", true],
      ["early", true],
      ["seen", false],
      ["main", false],
      ["merged", false],
    ],
  );
});

test("newest commit first compares times, not the dates' text across UTC offsets", async () => {
  const repo = repoOnMain(null);
  const older = repo.worktree("older");
  repo.commit(older, { "o.txt": "o\n" }, "2026-10-25T01:30:00+01:00");
  const newer = repo.worktree("newer");
  repo.commit(newer, { "n.txt": "n\n" }, "2026-10-25T01:10:00+00:00");

  assert.deepEqual(
    (await buildInbox([repo.root])).rows.map((r) => r.branch).slice(0, 2),
    ["newer", "older"],
  );
});

test("with a refused token and gh signed out, the repo asks to Connect GitHub and still lists its rows", async () => {
  const { inbox } = await inboxWithToken(repoOnGitHub("other"), () => ({
    status: 401,
  }));

  assert.equal(inbox.repos[0].connect, true);
  assert.equal(inbox.repos[0].unavailable, "GitHub isn't connected.");
  assert.deepEqual(inbox.repos[0].onGitHub, []);
  assert.deepEqual(
    inbox.rows.map((r) => [r.branch, r.pr]),
    [["feature", null]],
  );
});

const openPr = (number: number, branch: string, over = {}) => ({
  number,
  title: `PR ${number}`,
  isDraft: false,
  url: `https://github.com/acme/app/pull/${number}`,
  baseRefName: "main",
  headRefName: branch,
  isCrossRepository: false,
  author: { login: "teammate" },
  headRef: { target: { committedDate: "2026-10-02T00:00:00Z" } },
  ...over,
});

const head = (name: string, committedDate = "2026-10-01T00:00:00Z") => ({
  name,
  target: { committedDate },
});

/** The branch aliases as `inboxApi` answers them, plus what On GitHub reads. */
const onGitHubApi = (call: ApiCall): ApiAnswer => {
  const answer = inboxApi()(call).json as {
    data: { repository: Record<string, unknown> };
  };
  Object.assign(answer.data.repository, {
    open: {
      nodes: [
        openPr(8, "teammate/pr"),
        openPr(9, "their-fork", { isCrossRepository: true }),
        openPr(7, "feature"),
      ],
    },
    heads: {
      nodes: [
        head("aged", "2026-09-01T00:00:00Z"),
        head("main"),
        head("feature"),
        head("teammate/pr"),
        head("plain"),
      ],
    },
    defaultBranchRef: { name: "main" },
  });
  return { json: answer };
};

test("On GitHub lists same-repo PRs, then plain branches, leaving out local branches, the default branch and forks", async () => {
  const { inbox, calls } = await inboxWithToken(
    repoOnGitHub("listed"),
    onGitHubApi,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(inbox.repos[0].onGitHub, [
    {
      branch: "teammate/pr",
      lastCommitAt: "2026-10-02T00:00:00Z",
      pr: {
        number: 8,
        title: "PR 8",
        author: "teammate",
        isDraft: false,
        baseRefName: "main",
        url: "https://github.com/acme/app/pull/8",
      },
    },
    { branch: "plain", lastCommitAt: "2026-10-01T00:00:00Z", pr: null },
    { branch: "aged", lastCommitAt: "2026-09-01T00:00:00Z", pr: null },
  ]);
});

test("a clone with no local branches still asks GitHub, and still lists what's there", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "backstory-inbox-empty-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q", "-b", "nothing-yet");
  git("remote", "add", "origin", "git@github.com:acme/fresh.git");

  const { inbox, calls } = await inboxWithToken(root, onGitHubApi);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    inbox.repos[0].onGitHub.map((b) => b.branch),
    ["teammate/pr", "feature", "plain", "aged"],
  );
});
