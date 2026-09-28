import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseUnifiedDiff } from "../lib/diff";
import { anchorNotes, formatFeedback, locateNote } from "../lib/feedback";
import { changeNotes, getNotes } from "../lib/notes";
import type { Note } from "../lib/types";

const [file] = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,5 +10,6 @@
 keep
-gone
+new one
+new two
 }
 }
`);

let seq = 0;
function note(over: Partial<Note>): Note {
  return {
    id: `n${seq++}`,
    path: "src/a.ts",
    side: "new",
    line: 11,
    quote: "new one",
    body: "fix this",
    createdAt: seq,
    ...over,
  };
}

test("a note still on its line stays there", () => {
  assert.equal(locateNote(file, note({})), 11);
});

test("a note whose line moved is found by its text", () => {
  assert.equal(locateNote(file, note({ line: 40 })), 11);
});

test("a note whose text is gone is not placed", () => {
  assert.equal(locateNote(file, note({ quote: "edited away" })), null);
});

test("a note on a repeated line that moved is not guessed at", () => {
  // Two `}` lines: without its own line to confirm it, either could be it.
  assert.equal(locateNote(file, note({ line: 99, quote: "}" })), null);
  assert.equal(locateNote(file, note({ line: 14, quote: "}" })), 14);
});

test("an old-side note only lands on a removed line", () => {
  assert.equal(locateNote(file, note({ side: "old", line: 11, quote: "gone" })), 11);
  // Old line 10 is context, not a removal.
  assert.equal(locateNote(file, note({ side: "old", line: 10, quote: "keep" })), null);
});

test("anchorNotes sorts notes by side and keeps the unplaceable", () => {
  const { byNewLine, byOldLine, unanchored } = anchorNotes(file, [
    note({ id: "a" }),
    note({ id: "b", side: "old", line: 11, quote: "gone" }),
    note({ id: "c", quote: "nope" }),
  ]);
  assert.deepEqual(byNewLine.get(11)?.map((n) => n.id), ["a"]);
  assert.deepEqual(byOldLine.get(11)?.map((n) => n.id), ["b"]);
  assert.deepEqual(unanchored.map((n) => n.id), ["c"]);
});

test("formatFeedback quotes lines, uses current numbers in line order, and ends with general notes", () => {
  const text = formatFeedback(
    [
      note({ body: "general thought", path: null, line: null, quote: null }),
      note({ line: 12, quote: "new two", body: "second" }),
      note({ line: 30, quote: "new one", body: "first" }),
      note({ line: 5, quote: "vanished", body: "lost" }),
    ],
    [file],
  );

  assert.equal(
    text,
    [
      "Feedback on the uncommitted changes (4 notes):",
      "",
      "## src/a.ts (was line 5; it has changed since)",
      "```typescript",
      "vanished",
      "```",
      "lost",
      "",
      "## src/a.ts:11",
      "```typescript",
      "new one",
      "```",
      "first",
      "",
      "## src/a.ts:12",
      "```typescript",
      "new two",
      "```",
      "second",
      "",
      "## General",
      "",
      "general thought",
      "",
    ].join("\n"),
  );
});

test("a quote holding backticks gets a fence that can't close early", () => {
  const text = formatFeedback([note({ quote: "a ``` b", line: 99 })], []);
  assert.match(text, /^````\na ``` b\n````$/m);
});

test("notes persist per checkout, and edits keep their original time", async () => {
  process.env.DIFFER_HOME = mkdtempSync(path.join(tmpdir(), "differ-test-"));

  const first = note({ id: "one", createdAt: 100 });
  await changeNotes("/repo/a", { save: first });
  await changeNotes("/repo/b", { save: note({ id: "two" }) });
  await changeNotes("/repo/a", {
    save: { ...first, body: "edited", createdAt: 999 },
  });

  const a = await getNotes("/repo/a");
  assert.equal(a.length, 1);
  assert.equal(a[0].body, "edited");
  assert.equal(a[0].createdAt, 100);

  await changeNotes("/repo/a", { clear: true });
  assert.deepEqual(await getNotes("/repo/a"), []);
  assert.equal((await getNotes("/repo/b")).length, 1);

  const raw = JSON.parse(
    await fs.readFile(path.join(process.env.DIFFER_HOME, "notes.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(raw), ["/repo/b"]);

  await assert.rejects(
    changeNotes("/repo/b", { save: note({ id: "x", body: "   " }) }),
    /empty/,
  );
});
