import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUNDLE_ID, findMacApp, repoLink } from "../bin/macapp.mjs";
import { readText } from "./yaml";

test("a repo link carries the exact path, however awkward", () => {
  const root = "/Users/me/my repo/c++ & co #2";
  const link = new URL(repoLink(root));
  assert.equal(link.protocol, "differ:");
  assert.equal(link.host, "open");
  assert.equal(link.searchParams.get("repo"), root);
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

test("findMacApp takes the first candidate that is differ's Mac app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "differ-macapp-"));
  const safari = fakeApp(dir, "safari/differ.app", "com.apple.Safari.WebApp.1");
  const first = fakeApp(dir, "a/differ.app", BUNDLE_ID);
  const second = fakeApp(dir, "b/differ.app", BUNDLE_ID);
  const missing = path.join(dir, "nowhere/differ.app");
  assert.equal(findMacApp([missing, safari, first, second]), first);
});

test("findMacApp is null when no candidate is the Mac app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "differ-macapp-"));
  const safari = fakeApp(dir, "differ.app", "com.apple.Safari.WebApp.1");
  assert.equal(findMacApp([safari, path.join(dir, "gone.app")]), null);
  assert.equal(findMacApp([]), null);
});

test("the Mac app declares the scheme and bundle id the CLI relies on", () => {
  const plist = readText("mac/differ/differ/Info.plist");
  assert.match(
    plist,
    /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>differ<\/string>/,
  );
  const project = readText("mac/differ/differ.xcodeproj/project.pbxproj");
  const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)]
    .map((m) => m[1])
    .filter((id) => !/Tests$/.test(id));
  assert.ok(ids.length > 0, "the app target has no bundle id");
  for (const id of ids) assert.equal(id, BUNDLE_ID);
});
