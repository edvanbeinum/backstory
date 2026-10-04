import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUnifiedDiff, totals } from "../lib/diff";

test("parses a modified file with correct line numbering", () => {
  const [file] = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ header text
 keep
-gone
+new one
+new two
 tail
`);

  assert.equal(file.status, "modified");
  assert.equal(file.path, "src/a.ts");
  assert.equal(file.lang, "typescript");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);

  const lines = file.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.type, l.oldNo, l.newNo]),
    [
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ],
  );
  assert.equal(file.hunks[0].header, "header text");
});

test("detects added, deleted and renamed files", () => {
  const files = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-goodbye
diff --git a/from.ts b/to.ts
similarity index 92%
rename from from.ts
rename to to.ts
`);

  assert.deepEqual(
    files.map((f) => [f.status, f.path]),
    [
      ["added", "new.txt"],
      ["deleted", "old.txt"],
      ["renamed", "to.ts"],
    ],
  );
  assert.equal(files[2].oldPath, "from.ts");
  assert.equal(files[2].similarity, 92);
});

test("flags binary files instead of trying to render them", () => {
  const [file] = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 1234567..89abcde 100644
Binary files a/logo.png and b/logo.png differ
`);

  assert.equal(file.isBinary, true);
  assert.equal(file.hunks.length, 0);
  assert.equal(file.path, "logo.png");
});

test("handles quoted paths with spaces and unicode", () => {
  const [file] =
    parseUnifiedDiff(`diff --git "a/src/caf\\303\\251 menu.ts" "b/src/caf\\303\\251 menu.ts"
--- "a/src/caf\\303\\251 menu.ts"
+++ "b/src/caf\\303\\251 menu.ts"
@@ -1 +1 @@
-old
+new
`);

  assert.equal(file.path, "src/café menu.ts");
});

test("marks the line preceding a no-newline marker", () => {
  const [file] = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
`);

  const [removed, added] = file.hunks[0].lines;
  assert.equal(removed.noNewline, true);
  assert.equal(added.noNewline, undefined);
});

test("a single-line hunk range defaults to a count of one", () => {
  const [file] = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -7 +7 @@
-old
+new
`);

  const hunk = file.hunks[0];
  assert.equal(hunk.oldStart, 7);
  assert.equal(hunk.oldLines, 1);
  assert.equal(hunk.newStart, 7);
  assert.equal(hunk.newLines, 1);
});

test("totals sum across files", () => {
  const files = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 keep
+added
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1,2 +1,1 @@
 keep
-removed
`);

  assert.deepEqual(totals(files), { additions: 1, deletions: 1 });
});

test("an empty patch yields no files rather than a phantom one", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("\n"), []);
});
