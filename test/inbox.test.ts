import assert from "node:assert/strict";
import { test } from "node:test";

import { pickPullRequest } from "../lib/github";
import { countProgress } from "../lib/progress";
import type { ResponseRecord } from "../lib/responses";

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
  { number: 14034, state: "CLOSED", isCrossRepository: true, headRepositoryOwner: { login: "flynnjustin24" } },
  { number: 13940, state: "MERGED", isCrossRepository: true, headRepositoryOwner: { login: "pstoeckle" } },
  { number: 13929, state: "CLOSED", isCrossRepository: true, headRepositoryOwner: { login: "SkyMeilin" } },
  { number: 13797, state: "CLOSED", isCrossRepository: true, headRepositoryOwner: { login: "dx-nadee" } },
  { number: 13607, state: "CLOSED", isCrossRepository: true, headRepositoryOwner: { login: "Harsith2k5" } },
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
    { number: 3, state: "MERGED", isCrossRepository: false, headRepositoryOwner: null },
    { number: 4, state: "OPEN", isCrossRepository: false, headRepositoryOwner: null },
    { number: 9, state: "CLOSED", isCrossRepository: false, headRepositoryOwner: null },
  ];
  assert.equal(pickPullRequest(rows, "me")?.number, 4);
  assert.equal(
    pickPullRequest(rows.filter((r) => r.state !== "OPEN"), "me")?.number,
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
  const responses = { gone: record({ done: true }), t1: record({ done: true }) };
  const progress = countProgress(["t1"], responses);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 1);
});

test("more threads than one page returned is reported, not hidden", () => {
  const progress = countProgress(["t1"], { t1: record({ done: true }) }, {
    reportedTotal: 140,
  });
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
