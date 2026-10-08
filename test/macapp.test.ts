import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_PORT } from "../bin/hook.mjs";
import {
  BUNDLE_ID,
  findMacApp,
  launchPlan,
  NOT_INSTALLED,
  repoLink,
} from "../bin/macapp.mjs";
import { readText } from "./yaml";

const repo = "/Users/me/my repo/c++ & co";
const app = "/Applications/Backstory.app";

test("backstory launches the Mac app on the repo when nothing is running", () => {
  assert.deepEqual(
    launchPlan({ repo, port: DEFAULT_PORT, app, running: false }),
    { open: ["-a", app, repoLink(repo)] },
  );
});

test("backstory hands the repo to the Mac app that is already running", () => {
  assert.deepEqual(
    launchPlan({ repo, port: DEFAULT_PORT, app, running: true }),
    { open: ["-a", app, repoLink(repo)] },
  );
});

test("backstory opens the browser on a Backstory answering on another port", () => {
  const plan = launchPlan({ repo, port: 3000, app, running: true });
  assert.ok("open" in plan);
  const url = new URL(plan.open[0]);
  assert.equal(plan.open.length, 1);
  assert.equal(url.origin, "http://127.0.0.1:3000");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("repo"), repo);
});

test("backstory opens the browser on a default-port Backstory with no Mac app", () => {
  const plan = launchPlan({
    repo,
    port: DEFAULT_PORT,
    app: null,
    running: true,
  });
  assert.ok("open" in plan);
  assert.equal(new URL(plan.open[0]).searchParams.get("repo"), repo);
});

test("backstory says how to install the Mac app when there is none", () => {
  assert.deepEqual(
    launchPlan({ repo, port: DEFAULT_PORT, app: null, running: false }),
    { error: NOT_INSTALLED },
  );
});

test("backstory says nothing answers on another port it can't reach", () => {
  const plan = launchPlan({ repo, port: 3000, app, running: false });
  assert.ok("error" in plan);
  assert.match(plan.error, /:3000/);
});

test("a repo link carries the exact path, however awkward", () => {
  const root = "/Users/me/my repo/c++ & co #2";
  const link = new URL(repoLink(root));
  assert.equal(link.protocol, "backstory:");
  assert.equal(link.host, "open");
  assert.equal(link.searchParams.get("repo"), root);
  assert.ok(repoLink(root).startsWith("backstory://open?repo="));
});

function fakeApp(dir: string, name: string, bundleId: string) {
  const contents = path.join(dir, name, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
  return path.join(dir, name);
}

test("findMacApp takes the first candidate that is Backstory's Mac app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-macapp-"));
  const safari = fakeApp(
    dir,
    "safari/Backstory.app",
    "com.apple.Safari.WebApp.1",
  );
  const first = fakeApp(dir, "a/Backstory.app", BUNDLE_ID);
  const second = fakeApp(dir, "b/Backstory.app", BUNDLE_ID);
  const missing = path.join(dir, "nowhere/Backstory.app");
  assert.equal(findMacApp([missing, safari, first, second]), first);
});

test("findMacApp is null when no candidate is the Mac app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-macapp-"));
  const safari = fakeApp(dir, "Backstory.app", "com.apple.Safari.WebApp.1");
  assert.equal(findMacApp([safari, path.join(dir, "gone.app")]), null);
  assert.equal(findMacApp([]), null);
});

test("the Mac app declares the scheme and bundle id the CLI relies on", () => {
  assert.equal(BUNDLE_ID, "dev.backstory.app");
  const plist = readText("mac/backstory/Backstory/Info.plist");
  assert.match(
    plist,
    /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>backstory<\/string>/,
  );
  const project = readText("mac/backstory/Backstory.xcodeproj/project.pbxproj");
  const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)]
    .map((m) => m[1])
    .filter((id) => !/Tests$/.test(id));
  assert.ok(ids.length > 0, "the app target has no bundle id");
  for (const id of ids) assert.equal(id, BUNDLE_ID);
});
