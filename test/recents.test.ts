import assert from "node:assert/strict";
import { test } from "node:test";

import { removeFromList, touchList, type RecentRepo } from "../lib/recents";

const A = { path: "/repos/a", branch: "main" };
const B = { path: "/repos/b", branch: "feature/x" };

test("touch puts the entry first and dedupes by path", () => {
  let list: RecentRepo[] = [];
  list = touchList(list, A, 1);
  list = touchList(list, B, 2);
  assert.deepEqual(
    list.map((r) => r.path),
    ["/repos/b", "/repos/a"],
  );

  // Re-opening A moves it back to the front without duplicating it
  list = touchList(list, A, 3);
  assert.deepEqual(
    list.map((r) => r.path),
    ["/repos/a", "/repos/b"],
  );
  assert.equal(list[0].at, 3);
});

test("a branch switch updates the stored branch for the same path", () => {
  let list = touchList([], A, 1);
  list = touchList(list, { path: A.path, branch: "feature/y" }, 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].branch, "feature/y");
});

test("the list is capped, dropping the oldest", () => {
  let list: RecentRepo[] = [];
  for (let i = 0; i < 20; i++) {
    list = touchList(list, { path: `/repos/r${i}`, branch: null }, i);
  }
  assert.equal(list.length, 12);
  assert.equal(list[0].path, "/repos/r19");
  assert.equal(list[list.length - 1].path, "/repos/r8");
});

test("remove drops exactly the named path", () => {
  let list = touchList([], A, 1);
  list = touchList(list, B, 2);
  assert.deepEqual(
    removeFromList(list, "/repos/b").map((r) => r.path),
    ["/repos/a"],
  );
  // Unknown path is a no-op
  assert.equal(removeFromList(list, "/nope").length, 2);
});
