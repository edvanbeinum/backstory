import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseUnifiedDiff } from "../lib/diff";
import { anchorNotes, formatFeedback, locateNote } from "../lib/feedback";
import { changeNotes, getNotes, parseChange } from "../lib/notes";
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
    sentAt: null,
    done: false,
    doneAt: null,
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
  await changeNotes("/repo/a", { op: "save", note: first });
  await changeNotes("/repo/b", { op: "save", note: note({ id: "two" }) });
  await changeNotes("/repo/a", {
    op: "save",
    note: { ...first, body: "edited", createdAt: 999 },
  });

  const a = await getNotes("/repo/a");
  assert.equal(a.length, 1);
  assert.equal(a[0].body, "edited");
  assert.equal(a[0].createdAt, 100);

  await changeNotes("/repo/a", { op: "clearDrafts" });
  assert.deepEqual(await getNotes("/repo/a"), []);
  assert.equal((await getNotes("/repo/b")).length, 1);

  const raw = JSON.parse(
    await fs.readFile(path.join(process.env.DIFFER_HOME, "notes.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(raw), ["/repo/b"]);

  await assert.rejects(
    changeNotes("/repo/b", { op: "save", note: note({ id: "x", body: "   " }) }),
    /empty/,
  );
});

test("a note on a file with no uncommitted changes says so", () => {
  const text = formatFeedback([note({ path: "src/gone.ts", line: 7 })], [file]);
  assert.match(
    text,
    /^## src\/gone\.ts \(was line 7; the file has no uncommitted changes now\)$/m,
  );
});

test("sending makes a round; only sent notes tick; only drafts edit", async () => {
  process.env.DIFFER_HOME = mkdtempSync(path.join(tmpdir(), "differ-test-"));
  const root = "/repo/rounds";

  await changeNotes(root, { op: "save", note: note({ id: "a" }) });
  await changeNotes(root, { op: "save", note: note({ id: "b" }) });
  await changeNotes(root, { op: "save", note: note({ id: "c" }) });

  // A draft can't be ticked: nothing has had the chance to handle it.
  await changeNotes(root, { op: "tick", id: "c", done: true });
  assert.equal((await getNotes(root)).find((n) => n.id === "c")?.done, false);

  await changeNotes(root, { op: "send", ids: ["a", "b"], at: 5_000 });
  let notes = await getNotes(root);
  assert.deepEqual(
    notes.map((n) => [n.id, n.sentAt]),
    [["a", 5_000], ["b", 5_000], ["c", null]],
  );

  // What the agent read is fixed.
  await assert.rejects(
    changeNotes(root, { op: "save", note: { ...notes[0], body: "rewritten" } }),
    /already sent/,
  );

  await changeNotes(root, { op: "tick", id: "a", done: true });
  const doneAt = (await getNotes(root))[0].doneAt;
  assert.equal(typeof doneAt, "number");
  await changeNotes(root, { op: "tick", id: "a", done: true });
  assert.equal((await getNotes(root))[0].doneAt, doneAt);

  await changeNotes(root, { op: "clearDrafts" });
  await changeNotes(root, { op: "clearDone" });
  notes = await getNotes(root);
  assert.deepEqual(notes.map((n) => n.id), ["b"]);
});

test("notes saved before rounds existed read as drafts", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "differ-test-"));
  process.env.DIFFER_HOME = home;
  const legacy = note({ id: "old" }) as Partial<Note>;
  delete legacy.sentAt;
  delete legacy.done;
  delete legacy.doneAt;
  await fs.writeFile(
    path.join(home, "notes.json"),
    JSON.stringify({ "/repo/legacy": { old: legacy } }),
  );

  const [read] = await getNotes("/repo/legacy");
  assert.equal(read.id, "old");
  assert.equal(read.sentAt, null);
  assert.equal(read.done, false);
});

test("a change with an unknown op is refused", () => {
  assert.throws(() => parseChange({ op: "nuke" }), /unknown op/);
  assert.throws(() => parseChange({ op: "tick", id: "a" }), /Invalid tick/);
  assert.deepEqual(parseChange({ op: "clearDone", extra: 1 }), { op: "clearDone" });
});
