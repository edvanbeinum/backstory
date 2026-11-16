import assert from "node:assert/strict";
import { test } from "node:test";

import { langForPath } from "../lib/lang";

test("names a file's language from its extension, in any case", () => {
  assert.equal(langForPath("app/models/user.rb"), "ruby");
  assert.equal(langForPath("Sources/App/View.SWIFT"), "swift");
  assert.equal(langForPath("components/Story.tsx"), "tsx");
  assert.equal(langForPath("lib/schema.sql"), "sql");
});

test("names a file's language from its whole name before its extension", () => {
  assert.equal(langForPath("Dockerfile"), "docker");
  assert.equal(langForPath("deploy/Dockerfile.web"), "docker");
  assert.equal(langForPath("Gemfile"), "ruby");
  assert.equal(langForPath(".gitignore"), "gitignore");
});

test("leaves Xcode project files unhighlighted", () => {
  assert.equal(
    langForPath("mac/backstory/Backstory.xcodeproj/project.pbxproj"),
    null,
  );
});

test("names no language for an unknown extension, no extension or no path", () => {
  assert.equal(langForPath("data.unknownext"), null);
  assert.equal(langForPath("LICENSE"), null);
  assert.equal(langForPath("notes."), null);
  assert.equal(langForPath(null), null);
});
