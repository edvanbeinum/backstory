import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { credentialAttempts, fetchBranch } from "../lib/fetch";
import { RepoError, resolveRepo } from "../lib/git";
import { SECURITY, standIns } from "./standins";

// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-fetch-home-"),
);

const scratch = mkdtempSync(path.join(os.tmpdir(), "backstory-fetch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

function commit(dir: string, file: string, text: string) {
  writeFileSync(path.join(dir, file), text);
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", `Change ${file}`);
  return run(dir, "rev-parse", "HEAD");
}

/**
 * A bare `origin` with `main`, a teammate clone that pushes to it, and the
 * clone under review, which has only fetched `main`.
 */
function setup() {
  const dir = path.join(scratch, String(++count));
  const origin = path.join(dir, "origin.git");
  const teammate = path.join(dir, "teammate");
  const mine = path.join(dir, "mine");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, teammate], { stdio: "ignore" });
  run(teammate, "checkout", "-q", "-b", "main");
  commit(teammate, "a.txt", "a\n");
  run(teammate, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, mine], { stdio: "ignore" });
  return { origin, teammate, mine };
}

function pushFeature(teammate: string, text = "feature\n") {
  run(teammate, "checkout", "-q", "-B", "feature", "main");
  const tip = commit(teammate, "f.txt", text);
  run(teammate, "push", "-q", "-f", "origin", "feature");
  return tip;
}

const refs = (dir: string) =>
  run(dir, "for-each-ref", "--format=%(refname) %(objectname)");

const checkout = (dir: string) => ({
  branch: run(dir, "rev-parse", "--abbrev-ref", "HEAD"),
  head: run(dir, "rev-parse", "HEAD"),
  status: run(dir, "status", "--porcelain"),
});

test("a branch this clone has never fetched becomes a local branch to review, and the checkout stays as it was", async () => {
  const { teammate, mine } = setup();
  const tip = pushFeature(teammate);
  writeFileSync(path.join(mine, "wip.txt"), "uncommitted\n");
  const before = checkout(mine);

  const result = await fetchBranch(mine, "feature");

  assert.deepEqual(result, { outcome: "created", sha: tip });
  assert.equal(run(mine, "rev-parse", "refs/heads/feature"), tip);
  assert.equal(
    run(mine, "rev-parse", "--abbrev-ref", "feature@{upstream}"),
    "origin/feature",
  );
  const repo = await resolveRepo(mine, "feature");
  assert.equal(repo.ref, "feature");
  assert.deepEqual(checkout(mine), before);
});

test("a local branch called origin/feature doesn't stand in for origin's feature", async () => {
  const { teammate, mine } = setup();
  const tip = pushFeature(teammate);
  run(mine, "branch", "origin/feature", "main");

  assert.deepEqual(await fetchBranch(mine, "feature"), {
    outcome: "created",
    sha: tip,
  });
  assert.equal(run(mine, "rev-parse", "refs/heads/feature"), tip);
});

test("a new push moves the local branch, and nothing new leaves it unchanged", async () => {
  const { teammate, mine } = setup();
  pushFeature(teammate);
  await fetchBranch(mine, "feature");

  const next = commit(teammate, "f.txt", "more\n");
  run(teammate, "push", "-q", "origin", "feature");
  assert.deepEqual(await fetchBranch(mine, "feature"), {
    outcome: "updated",
    sha: next,
  });
  assert.equal(run(mine, "rev-parse", "refs/heads/feature"), next);

  assert.deepEqual(await fetchBranch(mine, "feature"), {
    outcome: "unchanged",
    sha: next,
  });
});

test("a teammate's force-push after a rebase moves a branch with nothing of its own", async () => {
  const { teammate, mine } = setup();
  pushFeature(teammate);
  await fetchBranch(mine, "feature");

  const rewritten = pushFeature(teammate, "rewritten\n");
  assert.deepEqual(await fetchBranch(mine, "feature"), {
    outcome: "updated",
    sha: rewritten,
  });
  assert.equal(run(mine, "rev-parse", "refs/heads/feature"), rewritten);
});

test("a local branch with a commit of its own is kept, and origin's copy still updates", async () => {
  const { teammate, mine } = setup();
  pushFeature(teammate);
  await fetchBranch(mine, "feature");
  run(mine, "checkout", "-q", "feature");
  const own = commit(mine, "mine.txt", "mine\n");
  run(mine, "checkout", "-q", "main");

  const next = commit(teammate, "f.txt", "more\n");
  run(teammate, "push", "-q", "origin", "feature");
  assert.deepEqual(await fetchBranch(mine, "feature"), {
    outcome: "kept",
    sha: own,
  });
  assert.equal(run(mine, "rev-parse", "refs/heads/feature"), own);
  assert.equal(run(mine, "rev-parse", "refs/remotes/origin/feature"), next);
});

test("a branch a linked worktree has checked out is left to that worktree", async () => {
  const { teammate, mine } = setup();
  const first = pushFeature(teammate);
  await fetchBranch(mine, "feature");
  const linked = path.join(path.dirname(mine), "linked");
  run(mine, "worktree", "add", "-q", linked, "feature");
  writeFileSync(path.join(linked, "wip.txt"), "uncommitted\n");
  const before = checkout(linked);

  const next = commit(teammate, "f.txt", "more\n");
  run(teammate, "push", "-q", "origin", "feature");
  const result = await fetchBranch(mine, "feature");

  assert.equal(result.outcome, "checked-out");
  assert.equal(result.sha, first);
  assert.equal(
    result.worktree && path.basename(result.worktree),
    path.basename(linked),
  );
  assert.deepEqual(checkout(linked), before);
  assert.equal(run(mine, "rev-parse", "refs/remotes/origin/feature"), next);
});

test("the base comes along, so All changes doesn't show what a newer base has", async () => {
  const { teammate, mine } = setup();
  pushFeature(teammate);
  run(teammate, "checkout", "-q", "main");
  const newer = commit(teammate, "b.txt", "b\n");
  run(teammate, "push", "-q", "origin", "main");

  await fetchBranch(mine, "feature", "main");
  assert.equal(run(mine, "rev-parse", "refs/remotes/origin/main"), newer);
});

test("without a base, the default branch comes along", async () => {
  const { teammate, mine } = setup();
  pushFeature(teammate);
  run(teammate, "checkout", "-q", "main");
  const newer = commit(teammate, "b.txt", "b\n");
  run(teammate, "push", "-q", "origin", "main");

  await fetchBranch(mine, "feature");
  assert.equal(run(mine, "rev-parse", "refs/remotes/origin/main"), newer);
});

test("a base origin no longer has doesn't stop the branch arriving", async () => {
  const { teammate, mine } = setup();
  const tip = pushFeature(teammate);
  assert.deepEqual(await fetchBranch(mine, "feature", "gone"), {
    outcome: "created",
    sha: tip,
  });
});

async function refusal(promise: Promise<unknown>): Promise<RepoError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof RepoError, String(err));
    return err;
  }
  assert.fail("expected a RepoError");
}

test("a branch origin doesn't have, no origin, and an unreachable origin each say so and change nothing", async () => {
  const { mine } = setup();
  const before = refs(mine);
  assert.equal(
    (await refusal(fetchBranch(mine, "nope"))).message,
    "`nope` isn't on origin.",
  );
  assert.equal(refs(mine), before);

  run(mine, "remote", "set-url", "origin", path.join(scratch, "missing.git"));
  const unreachable = await refusal(fetchBranch(mine, "feature"));
  assert.equal(unreachable.message, "Couldn't fetch `feature` from origin.");
  assert.match(unreachable.detail ?? "", /missing\.git/);
  assert.equal(refs(mine), before);

  run(mine, "remote", "remove", "origin");
  const remoteless = refs(mine);
  assert.equal(
    (await refusal(fetchBranch(mine, "feature"))).message,
    "This repo has no `origin` remote.",
  );
  assert.equal(refs(mine), remoteless);
});

test("a name git would read as an option or a range is refused before any fetch", async () => {
  const { origin, teammate, mine } = setup();
  pushFeature(teammate);
  const unfetched = path.join(path.dirname(mine), "unfetched");
  execFileSync("git", ["init", "-q", unfetched]);
  run(unfetched, "remote", "add", "origin", origin);
  for (const name of ["--upload-pack=x", "-x", "a..b", "@{-1}"]) {
    assert.equal(
      (await refusal(fetchBranch(unfetched, name))).message,
      `\`${name}\` isn't a branch name.`,
    );
    assert.equal(
      (await refusal(fetchBranch(unfetched, "feature", name))).message,
      `\`${name}\` isn't a branch name.`,
    );
  }
  assert.equal(refs(unfetched), "");
});

test("only an https github.com remote with a token gets the token, and only for github.com", () => {
  for (const url of [
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
  ]) {
    const attempts = credentialAttempts(url, "gho_abc123");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], {});
    const [env] = attempts;
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
    const value = env.GIT_CONFIG_VALUE_0 ?? "";
    assert.match(value, /^Authorization: Basic /);
    assert.equal(
      Buffer.from(value.replace(/^Authorization: Basic /, ""), "base64")
        .toString()
        .trim(),
      "x-access-token:gho_abc123",
    );
  }
  assert.deepEqual(credentialAttempts("https://github.com/acme/app", null), [
    {},
  ]);
  for (const url of [
    "ssh://git@github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "https://github.example.com/acme/app.git",
    "https://gitlab.com/acme/app.git",
    "http://github.com/acme/app.git",
    "/Users/someone/origin.git",
  ]) {
    assert.deepEqual(credentialAttempts(url, "gho_abc123"), [{}], url);
  }
});

test("with a token saved, a fetch from a non-GitHub origin never reads it and never puts it in argv", async () => {
  const { teammate, mine } = setup();
  const tip = pushFeature(teammate);
  const realGit = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  const dir = standIns({
    security: SECURITY,
    git: `echo "$*" >> "\${0%/*}/git.log"\nexec ${realGit} "$@"`,
  });
  writeFileSync(path.join(dir, "keychain"), "gho_saved1");
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  try {
    assert.deepEqual(await fetchBranch(mine, "feature"), {
      outcome: "created",
      sha: tip,
    });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(existsSync(path.join(dir, "security.log")), false);
  const argv = readFileSync(path.join(dir, "git.log"), "utf8");
  assert.match(argv, /fetch --no-tags origin/);
  assert.doesNotMatch(argv, /gho_saved1/);
});
