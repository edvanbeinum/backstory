import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKING_REV } from "../lib/constants";
import type { CommitSummary } from "../lib/types";
import {
  buildUrl,
  parseUrlState,
  resolveComment,
  resolveRev,
} from "../lib/url";

function commit(sha: string): CommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `subject for ${sha.slice(0, 7)}`,
    body: "",
    authorName: "Ed",
    authorEmail: "ed@example.com",
    date: "2026-07-28T00:00:00Z",
    url: null,
    isMerge: false,
  };
}

const NEWEST = "1e61946e49974e250cf688eda4c158132e12be83";
const OLDER = "0a901d8d0161f3519c4b0065cf14da1796cee8d3";
const COMMITS = [commit(NEWEST), commit(OLDER)];

test("round-trips awkward repo paths", () => {
  for (const repo of [
    "/Users/ed/Source Code/café-app",
    "/tmp/repo&with=separators",
    "/tmp/repo#hash",
    "/tmp/plus+and%percent",
  ]) {
    const url = buildUrl({ repo, rev: "abc123" });
    const parsed = parseUrlState(new URL(url, "http://x").search);
    assert.equal(parsed.repo, repo, `round-trip failed for ${repo}`);
    assert.equal(parsed.rev, "abc123");
  }
});

test("slashes stay readable, real separators stay encoded", () => {
  assert.equal(
    buildUrl({ repo: "/Users/ed/code/differ", rev: null }),
    "/?repo=/Users/ed/code/differ",
  );
  // & would otherwise split the query into a bogus second parameter
  assert.match(buildUrl({ repo: "/a&b", rev: null }), /%26/);
});

test("omits the default rev to keep the common URL short", () => {
  assert.equal(buildUrl({ repo: "/tmp/r", rev: WORKING_REV }), "/?repo=/tmp/r");
  assert.equal(
    buildUrl({ repo: "/tmp/r", rev: "abc123" }),
    "/?repo=/tmp/r&rev=abc123",
  );
});

const EMPTY = {
  repo: null,
  rev: null,
  mode: null,
  comment: null,
};

test("an empty query yields nulls, not empty strings", () => {
  assert.deepEqual(parseUrlState(""), EMPTY);
  assert.deepEqual(parseUrlState("?repo=&rev=  &comment=  "), EMPTY);
});

test("mode round-trips, and only the non-default one is written", () => {
  assert.equal(parseUrlState("?mode=commits").mode, "commits");
  assert.equal(parseUrlState("?mode=comments").mode, "comments");
  // An unknown mode is treated as absent rather than trusted into state
  assert.equal(parseUrlState("?mode=nonsense").mode, null);

  assert.match(buildUrl({ repo: "/r", mode: "commits" }), /mode=commits/);
  assert.doesNotMatch(buildUrl({ repo: "/r", mode: "comments" }), /mode=/);
});

test("a link carries your place in both lists", () => {
  const url = buildUrl({
    repo: "/r",
    mode: "commits",
    rev: "abc1234",
    comment: "PRRT_abc",
  });
  const parsed = parseUrlState(new URL(url, "http://x").search);

  // Toggling back to comments should not have lost the selected comment
  assert.equal(parsed.rev, "abc1234");
  assert.equal(parsed.comment, "PRRT_abc");
});

test("a comment id resolves, falling back to the first OPEN thread", () => {
  const threads = [
    { id: "resolved-one", isResolved: true },
    { id: "open-one", isResolved: false },
    { id: "open-two", isResolved: false },
  ];

  // A known id is honoured, resolved or not
  assert.deepEqual(resolveComment("resolved-one", threads), {
    commentId: "resolved-one",
    notice: null,
  });

  // Nothing requested → first open, not merely first
  assert.deepEqual(resolveComment(null, threads), {
    commentId: "open-one",
    notice: null,
  });

  // A stale id falls back and reports what was asked for
  assert.deepEqual(resolveComment("gone-thread", threads), {
    commentId: "open-one",
    notice: "gone-thread",
  });
});

test("comment resolution copes with all-resolved and empty PRs", () => {
  const allResolved = [{ id: "only", isResolved: true }];
  assert.equal(resolveComment(null, allResolved).commentId, "only");

  assert.deepEqual(resolveComment(null, []), {
    commentId: null,
    notice: null,
  });
  assert.deepEqual(resolveComment("gone", []), {
    commentId: null,
    notice: "gone",
  });
});

test("a short sha from a hand-typed URL resolves to the full one", () => {
  const { rev, notice } = resolveRev("1e61946", COMMITS, false);

  assert.equal(rev, NEWEST);
  assert.equal(notice, null);
});

test("a full sha resolves to itself", () => {
  assert.deepEqual(resolveRev(OLDER, COMMITS, false), {
    rev: OLDER,
    notice: null,
  });
});

test("a rev that is no longer unpushed falls back and says so", () => {
  const { rev, notice } = resolveRev("deadbee", COMMITS, false);

  assert.equal(rev, NEWEST, "falls back to the newest unpushed commit");
  assert.equal(notice, "deadbee", "and reports what was asked for");
});

test("working falls back to a commit when the tree is clean", () => {
  assert.deepEqual(resolveRev(WORKING_REV, COMMITS, false), {
    rev: NEWEST,
    notice: null,
  });
  assert.deepEqual(resolveRev(WORKING_REV, COMMITS, true), {
    rev: WORKING_REV,
    notice: null,
  });
});

test("the branch pseudo-rev holds when a branch diff exists, falls back otherwise", () => {
  assert.deepEqual(resolveRev("branch", COMMITS, false, true), {
    rev: "branch",
    notice: null,
  });
  // No combined view available → silent fallback, no scary notice
  assert.deepEqual(resolveRev("branch", COMMITS, false, false), {
    rev: NEWEST,
    notice: null,
  });
});

test("an empty repo with a clean tree still resolves to something", () => {
  assert.deepEqual(resolveRev(WORKING_REV, [], false), {
    rev: WORKING_REV,
    notice: null,
  });
  // A stale link into a repo with nothing to review shouldn't hard-fail
  assert.deepEqual(resolveRev("abc123", [], false), {
    rev: WORKING_REV,
    notice: "abc123",
  });
});
