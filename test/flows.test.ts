import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Runner } from "../lib/ai/provider";
import { generateFlows, traceHunk } from "../lib/flows/generate";
import {
  isAddedLine,
  mapNewToOld,
  mapOldToNew,
  parseZeroContext,
} from "../lib/flows/hunks";
import type { HeadOutput } from "../lib/flows/prompts";
import { fromSarif, toSarif } from "../lib/flows/sarif";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,2 +3 @@ x
-old1
-old2
+new1
@@ -10,0 +10,2 @@ y
+ins1
+ins2
`;

test("zero-context hunks map lines in both directions", () => {
  const hunks = parseZeroContext(PATCH);
  assert.equal(hunks.length, 2);
  assert.deepEqual(
    hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
    [
      [3, 2, 3, 1],
      [10, 0, 10, 2],
    ],
  );
  // Before the first hunk: untouched.
  assert.equal(mapOldToNew(hunks, "a.ts", 2), 2);
  // Replaced lines have no counterpart.
  assert.equal(mapOldToNew(hunks, "a.ts", 3), null);
  assert.equal(mapOldToNew(hunks, "a.ts", 4), null);
  // Between the hunks: one line shorter.
  assert.equal(mapOldToNew(hunks, "a.ts", 5), 4);
  // Line 10 is before the insertion point "after 10"; 11 is after it.
  assert.equal(mapOldToNew(hunks, "a.ts", 10), 9);
  assert.equal(mapOldToNew(hunks, "a.ts", 11), 12);
  assert.equal(mapNewToOld(hunks, "a.ts", 12), 11);
  assert.equal(mapNewToOld(hunks, "a.ts", 10), null);
  assert.equal(mapNewToOld(hunks, "a.ts", 4), 5);
  assert.equal(mapOldToNew(hunks, "other.ts", 3), 3);
  assert.ok(isAddedLine(hunks, "a.ts", 11));
  assert.ok(!isAddedLine(hunks, "a.ts", 12));
});

// A throwaway repo: Loader fetched twice; the change fetches once.
const repo = mkdtempSync(path.join(os.tmpdir(), "backstory-flows-test-"));
after(() => rmSync(repo, { recursive: true, force: true }));

const sh = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

sh("init", "-q");
sh("config", "user.email", "t@example.com");
sh("config", "user.name", "Test");
write(
  "src/Loader.ts",
  [
    "export class Loader {",
    "  load() {",
    "    this.repo.fetchAll();",
    "    this.repo.fetchAll();",
    "    render(this.items);",
    "  }",
    "}",
    "",
  ].join("\n"),
);
sh("add", ".");
sh("commit", "-qm", "base");
const BASE = sh("rev-parse", "HEAD");
write(
  "src/Loader.ts",
  [
    "export class Loader {",
    "  load() {",
    "    this.repo.fetchOnce();",
    "    render(this.items);",
    "  }",
    "}",
    "",
  ].join("\n"),
);
write("test/Loader.test.ts", "it('loads', () => {});\n");
sh("add", ".");
sh("commit", "-qm", "Fetch once");
const HEAD = sh("rev-parse", "HEAD");

const participants = [
  { name: "Loader", label: "Loader", external: false },
  { name: "Repo", label: "Repo", external: false },
];

const HEAD_ANSWER: HeadOutput = {
  flows: [
    {
      id: "load",
      name: "Open the list",
      trigger: "The list appears",
      isNew: false,
      participants,
      steps: [
        {
          id: "load.fetch",
          from: "Loader",
          to: "Repo",
          file: "src/Loader.ts",
          line: 3,
          caller: "Loader.load",
          label: "fetchOnce()",
          symbol: "fetchOnce()",
          nesting: 0,
        },
        {
          id: "load.render",
          from: "Loader",
          to: "Loader",
          file: "src/Loader.ts",
          line: 4,
          caller: "Loader.load",
          label: "render(items)",
          symbol: "render(this.items)",
          nesting: 0,
        },
        {
          id: "load.ghost",
          from: "Loader",
          to: "Repo",
          file: "src/Loader.ts",
          line: 2,
          caller: "Loader.load",
          label: "ghost()",
          symbol: "ghost(",
          nesting: 0,
        },
      ],
    },
  ],
  hunks: [{ id: "H1", flows: ["load"] }],
};

const BASE_ANSWER = {
  flows: [
    {
      id: "load",
      name: "Open the list",
      trigger: "The list appears",
      isNew: false,
      participants,
      steps: [
        {
          id: "load.fetch-1",
          from: "Loader",
          to: "Repo",
          file: "src/Loader.ts",
          line: 3,
          caller: "Loader.load",
          label: "fetchAll()",
          symbol: "fetchAll()",
          nesting: 0,
        },
        {
          id: "load.fetch-2",
          from: "Loader",
          to: "Repo",
          file: "src/Loader.ts",
          line: 4,
          caller: "Loader.load",
          label: "fetchAll() again",
          symbol: "fetchAll()",
          nesting: 0,
        },
        // Claude gets the carried step's line wrong; Backstory keeps the proven one.
        {
          id: "load.render",
          from: "Loader",
          to: "Loader",
          file: "src/Loader.ts",
          line: 99,
          caller: "Loader.load",
          label: "render(items)",
          symbol: "render(this.items)",
          nesting: 0,
        },
      ],
    },
  ],
};

test("flows are traced at the head, then walked back to the base", async () => {
  const prompts: string[] = [];
  const runner: Runner = async <T>(prompt: string) => {
    prompts.push(prompt);
    const answer = prompt.includes("as it ran at the base")
      ? BASE_ANSWER
      : HEAD_ANSWER;
    return {
      output: structuredClone(answer) as T,
      costUsd: 0.5,
      model: "claude-test",
    };
  };

  const set = await generateFlows({
    root: repo,
    base: BASE,
    head: HEAD,
    runner,
  });

  assert.equal(prompts.length, 2);
  // Tests are off the flows.
  assert.deepEqual(set.appFiles, ["src/Loader.ts"]);
  assert.ok(!prompts[0].includes("Loader.test.ts"));
  // The render step was carried to its base line before Claude saw it.
  assert.match(
    prompts[1],
    /"id": "load.render"[\s\S]*?"line": 5[\s\S]*?"status": "carried"/,
  );
  assert.match(prompts[1], /"id": "load.fetch"[\s\S]*?"status": "affected"/);

  const [flow] = set.flows;
  assert.equal(flow.isNew, false);
  assert.deepEqual(
    flow.after.map((s) => [s.id, s.verified]),
    [
      ["load.fetch", true],
      ["load.render", true],
      ["load.ghost", false],
    ],
  );
  assert.deepEqual(
    flow.before?.map((s) => [s.id, s.line, s.verified]),
    [
      ["load.fetch-1", 3, true],
      ["load.fetch-2", 4, true],
      ["load.render", 5, true],
    ],
  );
  assert.equal(set.costUsd, 1);
  assert.deepEqual(set.hunks[0].flows, ["load"]);

  // The cache is SARIF, and reads back the same.
  const roundTrip = fromSarif(
    JSON.parse(JSON.stringify(toSarif(set, `file://${repo}`))),
  );
  assert.deepEqual(roundTrip.flows, set.flows);
  assert.deepEqual(roundTrip.hunks, set.hunks);

  // Flows cached under the old name read back the same, app files included.
  const old = fromSarif(
    JSON.parse(
      JSON.stringify(toSarif(set, `file://${repo}`)).replaceAll(
        '"backstory.',
        '"differ.',
      ),
    ),
  );
  assert.deepEqual(old, fromSarif(toSarif(set, `file://${repo}`)));
  assert.deepEqual(old.appFiles, set.appFiles);
  assert.ok(old.appFiles.length > 0);
});

test("a new flow needs one run and has no before side", async () => {
  let runs = 0;
  const runner: Runner = async <T>() => {
    runs++;
    const answer = structuredClone(HEAD_ANSWER);
    answer.flows[0].isNew = true;
    return { output: answer as T, costUsd: 0.3, model: "claude-test" };
  };
  const set = await generateFlows({
    root: repo,
    base: BASE,
    head: HEAD,
    runner,
  });
  assert.equal(runs, 1);
  assert.equal(set.flows[0].before, null);
});

test("a hunk traced later is found by where it is, though the ids have moved", async () => {
  const newFlow: Runner = async <T>() => {
    const answer = structuredClone(HEAD_ANSWER);
    answer.flows[0].isNew = true;
    return { output: answer as T, costUsd: 0.3, model: "claude-test" };
  };
  const set = await generateFlows({
    root: repo,
    base: BASE,
    head: HEAD,
    runner: newFlow,
  });
  // Traced when another file counted as app code: Loader's hunk was H2.
  const loader = { ...set.hunks[0], id: "H2", flows: [] };
  const traced = {
    ...set,
    flows: [],
    hunks: [{ ...loader, id: "H1", file: "app/assets/site.css" }, loader],
  };
  const prompts: string[] = [];
  const runner: Runner = async <T>(prompt: string) => {
    prompts.push(prompt);
    return newFlow<T>(prompt, {}, repo);
  };
  const after = await traceHunk({
    root: repo,
    base: BASE,
    head: HEAD,
    runner,
    set: traced,
    hunkId: "H2",
  });
  assert.match(prompts[0], /src\/Loader\.ts/);
  assert.deepEqual(
    after.hunks.map((h) => [h.id, h.flows]),
    [
      ["H1", []],
      ["H2", ["load"]],
    ],
  );
});

test("a change with no app code makes no runs", async () => {
  write("test/Other.test.ts", "it('x', () => {});\n");
  sh("add", ".");
  sh("commit", "-qm", "Only a test");
  const runner: Runner = async () => {
    throw new Error("should not run");
  };
  const set = await generateFlows({
    root: repo,
    base: HEAD,
    head: sh("rev-parse", "HEAD"),
    runner,
  });
  assert.equal(set.flows.length, 0);
});

test("a symbol is found on a nearby line, or running over several", async () => {
  const { locate } = await import("../lib/flows/generate");
  const lines = [
    "def grants",
    "  user.access_grants",
    '    .where(grantable_type: "Container")',
    "    .group(:grantable_id)",
    "end",
    "",
    "def plays",
    '  Ahoy::Event.where(name: "play")',
  ];
  const read = async (_file: string, line: number) => lines[line - 1] ?? null;
  // Claude cited the line before the call: the step moves to where it is.
  assert.equal(
    await locate(read, "f.rb", 7, 'Ahoy::Event.where(name: "play")'),
    8,
  );
  // A chained call split across lines starts on its first line.
  assert.equal(
    await locate(
      read,
      "f.rb",
      2,
      'user.access_grants.where(grantable_type: "Container")',
    ),
    2,
  );
  // Too far away stays unverified.
  assert.equal(
    await locate(read, "f.rb", 1, 'Ahoy::Event.where(name: "play")'),
    null,
  );
  assert.equal(await locate(read, "f.rb", 3, "nowhere()"), null);
});

test("generated files are not app code", async () => {
  const { isAppCode } = await import("../lib/model");
  assert.equal(isAppCode(null, "archspec_facts/rails.yml"), false);
  assert.equal(isAppCode(null, "archspec_todo.yml"), false);
  assert.equal(isAppCode(null, "app/models/user.rb"), true);
});

test("every hunk reaches the prompt, however big the ones before it", async () => {
  const { hunkText } = await import("../lib/flows/hunks");
  const big = {
    id: "H1",
    file: "big.ts",
    oldFile: "big.ts",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 3000,
    text: Array.from(
      { length: 3000 },
      (_, i) => `+line ${i} of a very large new file`,
    ),
  };
  const small = {
    id: "H2",
    file: "small.ts",
    oldFile: "small.ts",
    oldStart: 3,
    oldLines: 1,
    newStart: 3,
    newLines: 1,
    text: ["-a", "+b"],
  };
  const text = hunkText([big, small], 8_000);
  assert.match(text, /^H1  big\.ts/);
  assert.match(text, /read the file for the rest/);
  assert.match(text, /H2  small\.ts  old 3,1  new 3,1\n-a\n\+b/);
  // Past the budget, a hunk is still named, with a pointer to the file.
  const tight = hunkText([big, small], 1_000);
  assert.match(tight, /H1  big\.ts.*\n\(content not shown here/);
  assert.match(tight, /H2  small\.ts/);
});

test("the hunk list stays near its budget, headers included", async () => {
  const { hunkText } = await import("../lib/flows/hunks");
  const many = Array.from({ length: 600 }, (_, i) => ({
    id: `H${i + 1}`,
    file: `app/models/model_${i}.rb`,
    oldFile: `app/models/model_${i}.rb`,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    text: ["-a", "+b"],
  }));
  const text = hunkText(many, 20_000);
  // Headers past the budget still count; the list stops at its cap.
  assert.ok(text.length < 20_000 + 400 * 120, `got ${text.length}`);
  assert.match(text, /H400  /);
  assert.doesNotMatch(text, /H401  /);
  assert.match(text, /200 more hunks not listed/);
});
