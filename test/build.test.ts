import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GET } from "../app/api/health/route";
import { readVersion } from "../lib/build";
import { readText, root } from "./yaml";

const version = (JSON.parse(readText("package.json")) as { version: string })
  .version;

test("health reports package.json's version from a checkout", () => {
  assert.equal(readVersion(root), version);
});

test("health reports the version from the standalone layout's directory", () => {
  const server = mkdtempSync(path.join(tmpdir(), "backstory-standalone-"));
  writeFileSync(
    path.join(server, "package.json"),
    JSON.stringify({ name: "backstory", version }),
  );
  assert.equal(readVersion(server), version);
});

test("a server with no package.json reports an unknown version", () => {
  assert.equal(
    readVersion(mkdtempSync(path.join(tmpdir(), "backstory-"))),
    "unknown",
  );
});

test("health says it's Backstory, which the CLI and the Mac app check for", async () => {
  const body = (await (await GET()).json()) as { app: string };
  assert.equal(body.app, "backstory");
});
