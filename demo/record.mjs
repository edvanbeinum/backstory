// Record what Backstory's server answers for one change, for the site's demo.
//
// Run Backstory's server, check out the change's branch somewhere, then:
//   node demo/record.mjs http://127.0.0.1:3000 /path/to/checkout demo/pr-117.json
//
// It opens the change, traces it if it isn't traced yet, clicks every flow
// step so each step's code is recorded, walks every part and opens Files
// changed. The checkout's path, your home folder and BACKSTORY_HOME, if the
// server runs with one, are replaced with DEMO_REPO and DEMO_HOME, so the
// recording names no folder on this machine.
import { realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { chromium } from "playwright";

import { DEMO_HOME, DEMO_REPO, IGNORED_PARAMS } from "./recording.mjs";

const [server, checkout, out] = process.argv.slice(2);
if (!server || !checkout || !out) {
  console.error(
    "usage: node demo/record.mjs <server url> <checkout> <out.json>",
  );
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const responses = new Map();
page.on("response", async (response) => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/")) return;
  const method = response.request().method();
  const params = Object.fromEntries(
    [...url.searchParams].filter(([name]) => !IGNORED_PARAMS.includes(name)),
  );
  let body;
  try {
    body = await response.json();
  } catch {
    return;
  }
  // A polled route answers "running" before "done"; the last answer wins.
  responses.set(`${method} ${url.pathname}?${new URLSearchParams(params)}`, {
    method,
    path: url.pathname,
    params,
    status: response.status(),
    body,
  });
});

const settle = (ms = 2000) => page.waitForTimeout(ms);
await page.goto(`${server}/?${new URLSearchParams({ repo: checkout })}`);
await settle(12000);

await page.getByText("Show everything on one page").click();
await settle(3000);
const trace = page.getByRole("button", { name: "Trace this change" });
if (await trace.count()) {
  await trace.click();
  const started = Date.now();
  while (!(await page.locator(".flow-card").count())) {
    if (Date.now() - started > 600_000)
      throw new Error("The trace took over 10 minutes.");
    await settle(10_000);
  }
}
const cards = page.locator(".flow-card");
for (let i = 0; i < (await cards.count()); i++) {
  const card = cards.nth(i);
  if (!(await card.getAttribute("class")).includes("open")) {
    await card.locator("button").first().click();
    await settle(1500);
  }
  const rows = card.locator("[data-row]");
  for (let j = 0; j < (await rows.count()); j++) {
    await rows.nth(j).click();
    await settle(1200);
  }
}

await page.getByText("Walk me through it").click();
await settle();
const next = page.locator(".walk-bar button").filter({ hasText: "›" });
while ((await next.count()) && !(await next.isDisabled())) {
  await next.click();
  await settle();
}
await page.getByText("Files changed").first().click();
await settle(4000);
await browser.close();

let json = JSON.stringify([...responses.values()], null, 1);
for (const path of new Set([checkout, realpathSync(checkout)])) {
  json = json.replaceAll(path, DEMO_REPO);
}
if (process.env.BACKSTORY_HOME) {
  json = json.replaceAll(process.env.BACKSTORY_HOME, `${DEMO_HOME}/.backstory`);
}
json = json.replaceAll(homedir(), DEMO_HOME);
writeFileSync(out, json + "\n");
console.log(`Recorded ${responses.size} responses to ${out}`);
