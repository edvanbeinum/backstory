import assert from "node:assert/strict";
import { test } from "node:test";

import { LABEL, parsePort, renderPlist } from "../bin/launchd.mjs";

const spec = {
  server: "/opt/differ/standalone/server.js",
  port: 4460,
  pathEnv:
    "/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin",
  log: "/Users/me/.differ/server.log",
};

test("the plist runs node from the captured PATH, bound to localhost", () => {
  const plist = renderPlist(spec);
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(
    plist,
    /<string>\/usr\/bin\/env<\/string>\s*<string>node<\/string>\s*<string>\/opt\/differ\/standalone\/server\.js<\/string>/,
  );
  assert.match(plist, /<key>HOSTNAME<\/key>\s*<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/Users\/me\/\.nvm/);
  assert.doesNotMatch(plist, /DIFFER_HOME/);
});

test("the port reads back out of the plist", () => {
  assert.equal(parsePort(renderPlist({ ...spec, port: 4471 })), 4471);
  assert.equal(parsePort("<plist></plist>"), null);
});

test("paths are XML-escaped", () => {
  const plist = renderPlist({ ...spec, server: "/Users/me/R&D <x>/server.js" });
  assert.match(plist, /R&amp;D &lt;x&gt;/);
});

test("the same inputs render the same plist, so an unchanged agent isn't rewritten", () => {
  assert.equal(renderPlist(spec), renderPlist({ ...spec }));
  assert.notEqual(
    renderPlist(spec),
    renderPlist({ ...spec, pathEnv: "/usr/bin" }),
  );
});
