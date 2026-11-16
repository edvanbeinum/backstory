import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { attachComponents } from "../lib/flows/components";
import type { FlowSet, FlowStep } from "../lib/flows/types";

// Strip the user's git config and any `GIT_*` a pre-push hook exported, so
// git sees only the temp repos it's given.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.BACKSTORY_HOME ??= mkdtempSync(
  path.join(os.tmpdir(), "backstory-components-home-"),
);

const scratch = mkdtempSync(path.join(os.tmpdir(), "backstory-components-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

function repo(files: Record<string, string>) {
  const dir = path.join(scratch, String(++count));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  git("add", "-A");
  git("commit", "-qm", "First");
  return { dir, head: git("rev-parse", "HEAD") };
}

const MODEL = `workspace {
    !identifiers hierarchical
    model {
        app = softwareSystem "App" {
            web = container "Web" {
                a = component "Alpha" {
                    properties {
                        "code.globs" "src/a/**"
                    }
                }
                b = component "Beta" {
                    properties {
                        "code.globs" "src/b/**"
                    }
                }
            }
        }
    }
}
`;

const step = (from: string, to: string, file: string): FlowStep => ({
  id: `${from}-${to}`,
  from,
  to,
  file,
  line: 1,
  caller: `${from}.run`,
  label: "calls",
  symbol: "run",
  nesting: 0,
  verified: true,
});

function flowSet(head: string): FlowSet {
  return {
    base: null,
    head,
    generatedAt: 0,
    flows: [
      {
        id: "F1",
        name: "Save",
        trigger: "POST /save",
        isNew: true,
        participants: [
          { name: "Controller", label: "Controller", external: false },
          { name: "Store", label: "Store", external: false },
          { name: "Rails", label: "Rails", external: true },
        ],
        before: null,
        after: [
          step("Controller", "Store", "src/a/controller.ts"),
          step("Controller", "Rails", "src/a/controller.ts"),
        ],
      },
    ],
    hunks: [],
    appFiles: [],
    costUsd: 0,
    durationMs: 0,
  };
}

const components = (set: FlowSet) =>
  Object.fromEntries(
    set.flows[0].participants.map((p) => [p.name, p.component]),
  );

test("puts a participant in the component its calls are made from", async () => {
  const { dir, head } = repo({
    "architecture/workspace.dsl": MODEL,
    "src/a/controller.ts": "export class Controller {}\n",
    "src/b/Store.ts": "export class Store {}\n",
  });

  const set = await attachComponents(dir, flowSet(head));

  assert.equal(components(set).Controller, "Alpha");
});

test("puts a type that only gets called in the component of the file that defines it, preferring the conventional file", async () => {
  const { dir, head } = repo({
    "architecture/workspace.dsl": MODEL,
    "src/a/controller.ts": "export class Controller {}\n",
    "src/a/admin.ts": "export class Store {}\n",
    "src/b/Store.ts": "export class Store {}\n",
  });

  const set = await attachComponents(dir, flowSet(head));

  assert.equal(components(set).Store, "Beta");
});

test("leaves an external participant out of every component", async () => {
  const { dir, head } = repo({
    "architecture/workspace.dsl": MODEL,
    "src/a/controller.ts": "export class Controller {}\n",
    "src/a/Rails.ts": "export class Rails {}\n",
  });

  const set = await attachComponents(dir, flowSet(head));

  assert.equal(components(set).Rails, null);
});

test("leaves the flows as they are when the repo has no model", async () => {
  const { dir, head } = repo({
    "src/a/controller.ts": "export class Controller {}\n",
  });
  const set = flowSet(head);

  assert.equal(await attachComponents(dir, set), set);
});
