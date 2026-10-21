import assert from "node:assert/strict";
import { test } from "node:test";

import { anchorThreads } from "../lib/anchor";
import { parseUnifiedDiff } from "../lib/diff";
import type { ReviewThread } from "../lib/types";

function thread(
  id: string,
  line: number | null,
  opts: Partial<ReviewThread> = {},
): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/app.ts",
    line,
    originalLine: null,
    startLine: null,
    side: "RIGHT",
    comments: [],
    ...opts,
  };
}

// A hunk covering new-side lines 31–40 only. Line 5 and line 99 exist in the
// file but not in the diff, which is the case that must not silently vanish.
const PATCH = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -31,7 +31,10 @@ class Thing {
 context at 31
 context at 32
-removed old 33
+added new 33
+added new 34
+added new 35
 context at 36
 context at 37
 context at 38
`;

test("anchors a thread onto a line inside the diff", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { byNewLine, unanchored } = anchorThreads(file, [thread("t1", 34)]);

  assert.equal(unanchored.length, 0);
  assert.deepEqual(
    byNewLine.get(34)?.map((t) => t.id),
    ["t1"],
  );
});

test("a line outside the hunks falls through to unanchored, never dropped", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { byNewLine, byOldLine, unanchored } = anchorThreads(file, [
    thread("inside", 34),
    thread("far-below", 99),
    thread("far-above", 5),
  ]);

  assert.deepEqual(unanchored.map((t) => t.id).sort(), [
    "far-above",
    "far-below",
  ]);
  // Nothing invented on lines that aren't in the diff
  assert.equal(byNewLine.get(99), undefined);
  assert.equal(byNewLine.get(5), undefined);
  assert.equal(byOldLine.size, 0);

  // Every thread is accounted for exactly once
  const anchored = [...byNewLine.values(), ...byOldLine.values()].flat();
  assert.equal(anchored.length + unanchored.length, 3);
});

test("LEFT-side threads anchor against old line numbers", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { byOldLine, byNewLine, unanchored } = anchorThreads(file, [
    thread("left", 33, { side: "LEFT" }),
  ]);

  assert.deepEqual(
    byOldLine.get(33)?.map((t) => t.id),
    ["left"],
  );
  assert.equal(byNewLine.size, 0);
  assert.equal(unanchored.length, 0);
});

test("an outdated thread falls back to originalLine", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { byNewLine } = anchorThreads(file, [
    thread("outdated", null, { originalLine: 36, isOutdated: true }),
  ]);

  assert.deepEqual(
    byNewLine.get(36)?.map((t) => t.id),
    ["outdated"],
  );
});

test("a thread with no line information at all is still surfaced", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { unanchored } = anchorThreads(file, [thread("fileLevel", null)]);

  assert.deepEqual(
    unanchored.map((t) => t.id),
    ["fileLevel"],
  );
});

test("two threads on the same line both anchor", () => {
  const [file] = parseUnifiedDiff(PATCH);
  const { byNewLine } = anchorThreads(file, [thread("a", 34), thread("b", 34)]);

  assert.deepEqual(
    byNewLine.get(34)?.map((t) => t.id),
    ["a", "b"],
  );
});
