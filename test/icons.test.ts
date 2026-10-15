import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readText, root } from "./yaml";

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

function readBytes(file: string): Buffer {
  return readFileSync(path.join(root, file));
}

// Read width and height from the IHDR chunk, which always starts at byte 16.
function pngSize(file: string): [number, number] {
  const png = readBytes(file);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

// Read each image's width from the ICO directory; 0 means 256.
function icoSizes(file: string): number[] {
  const ico = readBytes(file);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
}

const copies = [
  { app: "public/icon-192.png", logo: "backstory-icon-192.png", size: 192 },
  { app: "public/icon-512.png", logo: "backstory-icon-512.png", size: 512 },
  {
    app: "public/apple-touch-icon.png",
    logo: "backstory-icon-180.png",
    size: 180,
  },
];

for (const { app, logo, size } of copies) {
  test(`${app} is the ${size}px landing page logo`, () => {
    assert.deepEqual(pngSize(app), [size, size]);
    assert.ok(readBytes(app).equals(readBytes(`site/img/logo/${logo}`)));
  });
}

test("the favicon is the landing page's 16/32/48 favicon", () => {
  assert.deepEqual(
    icoSizes("app/favicon.ico").sort((a, b) => a - b),
    [16, 32, 48],
  );
  assert.ok(
    readBytes("app/favicon.ico").equals(readBytes("site/img/logo/favicon.ico")),
  );
});
