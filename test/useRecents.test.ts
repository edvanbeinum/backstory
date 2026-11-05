import { act, renderHook } from "./render";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useRecents } from "../components/useRecents";

const KEY = "backstory.recentRepos";

function stored() {
  return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Array<{
    path: string;
    branch: string | null;
  }>;
}

beforeEach(() => localStorage.clear());

test("the list is read from localStorage on mount", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify([{ path: "/repos/a", branch: "main", at: 1 }]),
  );
  const { result } = await renderHook(useRecents, undefined);
  assert.deepEqual(
    result.current.list.map((r) => r.path),
    ["/repos/a"],
  );
});

test("touch puts the repo first and writes the list back", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify([{ path: "/repos/a", branch: "main", at: 1 }]),
  );
  const { result } = await renderHook(useRecents, undefined);
  await act(async () => result.current.touch("/repos/b", "feature/x"));
  assert.deepEqual(
    result.current.list.map((r) => r.path),
    ["/repos/b", "/repos/a"],
  );
  assert.deepEqual(stored()[0], {
    path: "/repos/b",
    branch: "feature/x",
    at: result.current.list[0].at,
  });
});

test("remove drops the repo and writes the list back", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify([
      { path: "/repos/a", branch: "main", at: 2 },
      { path: "/repos/b", branch: null, at: 1 },
    ]),
  );
  const { result } = await renderHook(useRecents, undefined);
  await act(async () => result.current.remove("/repos/a"));
  assert.deepEqual(
    result.current.list.map((r) => r.path),
    ["/repos/b"],
  );
  assert.deepEqual(
    stored().map((r) => r.path),
    ["/repos/b"],
  );
});

test("unreadable storage gives an empty list", async () => {
  localStorage.setItem(KEY, "{not json");
  const { result } = await renderHook(useRecents, undefined);
  assert.deepEqual(result.current.list, []);
});
