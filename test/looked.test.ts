import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lookedTips, markLooked } from "../lib/looked";

function tempHome(): void {
  process.env.BACKSTORY_HOME = mkdtempSync(
    path.join(tmpdir(), "backstory-looked-"),
  );
}

test("a marked branch reads back with its tip and time", () => {
  tempHome();
  assert.deepEqual(lookedTips("/a/.git"), new Map());
  markLooked("/a/.git", "feature", "a".repeat(40), 5);
  assert.deepEqual(
    lookedTips("/a/.git"),
    new Map([["feature", { tip: "a".repeat(40), at: 5 }]]),
  );
});

test("a second mark replaces the first", () => {
  tempHome();
  markLooked("/a/.git", "feature", "a".repeat(40), 5);
  markLooked("/a/.git", "feature", "b".repeat(40), 9);
  assert.deepEqual(
    lookedTips("/a/.git"),
    new Map([["feature", { tip: "b".repeat(40), at: 9 }]]),
  );
});

test("two repos with a branch of the same name keep their own marks", () => {
  tempHome();
  markLooked("/a/.git", "feature", "a".repeat(40), 5);
  markLooked("/b/.git", "feature", "b".repeat(40), 6);
  assert.equal(lookedTips("/a/.git").get("feature")?.tip, "a".repeat(40));
  assert.equal(lookedTips("/b/.git").get("feature")?.tip, "b".repeat(40));
});
