/**
 * Checks the built Mac app end to end, in both modes. Attached: against a
 * stand-in server, a `differ://open` link loads `/?repo=<path>`, and the app
 * survives the server going away. Owned: the app starts the server in its
 * bundle, and the server goes when the app quits or is killed. Needs a login
 * session, so it isn't part of verify. Runs on spare ports with a temporary
 * DIFFER_HOME, so it touches neither `~/.differ`, port 4460, nor the login
 * agent.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repoLink } from "../bin/macapp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "build", "differ.app");
const executable = path.join(app, "Contents", "MacOS", "differ");
if (!existsSync(app)) {
  console.error(`mac:smoke: no ${app} — run npm run mac:build first`);
  process.exit(1);
}
const { version } = JSON.parse(
  readFileSync(path.join(here, "..", "package.json"), "utf8"),
);

async function waitFor(what, check, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function launch(args) {
  const child = spawn(executable, args, { stdio: "ignore" });
  child.exited = false;
  child.on("exit", () => (child.exited = true));
  return child;
}

async function attached() {
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
  const repoLoaded = (repo) =>
    seen.some((url) => {
      const parsed = new URL(url, base);
      return (
        parsed.pathname === "/" && parsed.searchParams.get("repo") === repo
      );
    });

  const child = launch(["-serverURL", base]);
  try {
    await waitFor("the app's first page load", () => seen.includes("/"));

    const repo = mkdtempSync(path.join(tmpdir(), "differ smoke c++ & co "));
    await promisify(execFile)("open", ["-a", app, repoLink(repo)]);
    try {
      await waitFor(`GET /?repo=${repo}`, () => repoLoaded(repo));
    } catch (err) {
      throw new Error(`${err.message}; the server saw ${seen}`);
    }

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (child.exited) throw new Error("the app exited when its server went");
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
    await waitFor("the attached app to exit", () => child.exited, 5000);
  }
}

async function sparePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return await response.json();
  } catch {
    return null;
  }
}

async function owned() {
  const port = await sparePort();
  const differHome = mkdtempSync(path.join(tmpdir(), "differ-smoke-home-"));
  const args = ["-port", String(port), "-differHome", differHome];
  const log = path.join(differHome, "server.log");
  const up = async () => (await health(port))?.version === version;
  const down = async () => !(await health(port));
  const withLog = async (step) => {
    try {
      await step();
    } catch (err) {
      const tail = existsSync(log) ? readFileSync(log, "utf8") : "";
      throw new Error(`${err.message}\n--- ${log}\n${tail.slice(-2000)}`);
    }
  };

  let child = launch(args);
  try {
    await withLog(() => waitFor(`differ ${version} on :${port}`, up));

    const repo = mkdtempSync(path.join(tmpdir(), "differ smoke owned "));
    await promisify(execFile)("open", ["-a", app, repoLink(repo)]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (child.exited) throw new Error("the app exited on a differ:// link");
    if (!(await up())) throw new Error("the server went on a differ:// link");

    child.kill("SIGTERM");
    await waitFor("the server to stop after SIGTERM", down, 5000);

    child = launch(args);
    await withLog(() => waitFor("the server to start again", up));
    child.kill("SIGKILL");
    await waitFor("the server to stop after SIGKILL", down, 5000);
  } finally {
    child.kill("SIGKILL");
  }
}

let failed = false;
for (const [name, check] of [
  ["attached", attached],
  ["owned", owned],
]) {
  try {
    await check();
    console.log(`mac:smoke: ${name} passed`);
  } catch (err) {
    console.error(`mac:smoke: ${name} failed: ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
