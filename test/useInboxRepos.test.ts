import { act, renderHook } from "./render";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useInboxRepos } from "../components/useInboxRepos";
import { INBOX_ROOTS_KEY } from "../lib/constants";

const RECENTS = "backstory.recentRepos";

function stored() {
  return JSON.parse(localStorage.getItem(INBOX_ROOTS_KEY) ?? "null");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    RECENTS,
    JSON.stringify([
      { path: "/repos/a", branch: "main", at: 2 },
      { path: "/repos/wt", branch: "x", at: 1 },
    ]),
  );
});

test("the repos are read on mount and seeded from recents", async () => {
  localStorage.setItem(INBOX_ROOTS_KEY, JSON.stringify(["/repos/z", 3]));
  const { result } = await renderHook(useInboxRepos, undefined);
  assert.deepEqual(result.current.repos, ["/repos/z", "/repos/a", "/repos/wt"]);
});

test("remember adds a repo once and writes the list", async () => {
  const { result } = await renderHook(useInboxRepos, undefined);
  await act(async () => result.current.remember("/repos/b"));
  await act(async () => result.current.remember("/repos/b"));
  assert.deepEqual(result.current.repos, ["/repos/a", "/repos/wt", "/repos/b"]);
  assert.deepEqual(stored(), ["/repos/a", "/repos/wt", "/repos/b"]);
});

test("forget drops repos and writes the list", async () => {
  const { result } = await renderHook(useInboxRepos, undefined);
  await act(async () => result.current.forget(["/repos/wt"]));
  assert.deepEqual(result.current.repos, ["/repos/a"]);
  assert.deepEqual(stored(), ["/repos/a"]);
});

test("bad JSON falls back to recents' paths", async () => {
  localStorage.setItem(INBOX_ROOTS_KEY, "[oops");
  const { result } = await renderHook(useInboxRepos, undefined);
  assert.deepEqual(result.current.repos, ["/repos/a", "/repos/wt"]);
});
