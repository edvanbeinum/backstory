import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { snippet } from "../lib/snippet";

const repo = mkdtempSync(path.join(os.tmpdir(), "differ-snippet-test-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const sh = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

sh("init", "-q");
sh("config", "user.email", "t@t");
sh("config", "user.name", "t");
write("app/old_name.rb", `${body.join("\n")}\n`);
sh("add", "-A");
sh("commit", "-qm", "base");
const base = sh("rev-parse", "HEAD");
sh("mv", "app/old_name.rb", "app/new_name.rb");
write("app/new_name.rb", `${body.map((l, i) => (i === 9 ? "line ten" : l)).join("\n")}\n`);
sh("add", "-A");
sh("commit", "-qm", "rename");
const head = sh("rev-parse", "HEAD");

test("a step in a renamed file shows only what changed", async () => {
  const s = await snippet({ root: repo, base, head, path: "app/new_name.rb", side: "new", line: 5 });
  assert.ok(s);
  const types = s.file.hunks[0].lines.map((l) => l.type);
  assert.equal(s.file.hunks[0].lines[s.target].type, "context");
  assert.ok(types.includes("add") && types.includes("del"));
  assert.equal(types.filter((t) => t === "add").length, 1);
});

test("a removed line in a renamed file is found under its new name", async () => {
  const s = await snippet({ root: repo, base, head, path: "app/new_name.rb", side: "old", line: 10 });
  assert.ok(s);
  assert.equal(s.file.hunks[0].lines[s.target].content, "line 10");
});
