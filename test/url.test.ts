import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKING_REV } from "../lib/constants";
import type { CommitSummary } from "../lib/types";
import { buildUrl, parseUrlState, resolveRev } from "../lib/url";

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

test("an empty query yields nulls, not empty strings", () => {
  assert.deepEqual(parseUrlState(""), { repo: null, rev: null });
  assert.deepEqual(parseUrlState("?repo=&rev=  "), { repo: null, rev: null });
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
