import assert from "node:assert/strict";
import { test } from "node:test";

import { readText } from "./yaml";

const icon = readText("public/icon.svg");

test("the app icon is the C4 logo, not the diff mark", () => {
  assert.ok(!icon.includes("#cf222e"));
  assert.ok(icon.includes('d="M32 24V31H18V38M32 31H46V38"'));
  assert.equal(icon.match(/<rect[^>]*fill="#1f883d"/g)?.length, 1);
});

test("the app icon is the landing page's logo without its C2PA metadata", () => {
  const logo = readText("site/img/logo/backstory-icon.svg")
    .replace(/<metadata>[\s\S]*<\/metadata>/, "")
    .replace('aria-label="backstory"', 'aria-label="Backstory"');
  assert.equal(icon.trim(), logo.trim());
});
