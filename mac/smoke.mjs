/**
 * Checks the built Mac app end to end against a stand-in server on a spare
 * port: a `differ://open` link loads `/?repo=<path>`, and the app survives the
 * server going away. Needs a login session, so it isn't part of verify.
 * Touches neither `~/.differ` nor port 4460.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repoLink } from "../bin/macapp.mjs";

const app = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "build",
  "differ.app",
);
if (!existsSync(app)) {
  console.error(`mac:smoke: no ${app} — run npm run mac:build first`);
  process.exit(1);
}

const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.url);
  if (req.url === "/api/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ app: "differ", build: "smoke" }));
  } else {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>stand-in</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const child = spawn(
  path.join(app, "Contents", "MacOS", "differ"),
  ["-serverURL", base],
  { stdio: "ignore" },
);
let exited = false;
child.on("exit", () => (exited = true));

async function waitFor(what, check, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}; the server saw ${seen}`);
}

function repoLoaded(repo) {
  return seen.some((url) => {
    const parsed = new URL(url, base);
    return parsed.pathname === "/" && parsed.searchParams.get("repo") === repo;
  });
}

let failed = false;
try {
  await waitFor("the app's first page load", () => seen.includes("/"));

  const repo = mkdtempSync(path.join(tmpdir(), "differ smoke c++ & co "));
  await promisify(execFile)("open", ["-a", app, repoLink(repo)]);
  await waitFor(`GET /?repo=${repo}`, () => repoLoaded(repo));

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5000));
  if (exited) throw new Error("the app exited when the server went away");

  console.log("mac:smoke passed");
} catch (err) {
  console.error(`mac:smoke failed: ${err.message}`);
  failed = true;
} finally {
  child.kill();
  server.closeAllConnections();
  server.close();
}
process.exit(failed ? 1 : 0);
