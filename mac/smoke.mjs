/**
 * Checks the built Mac app end to end. Attached: against a stand-in server, a
 * `backstory://open` link loads `/?repo=<path>`, and the app survives the
 * server going away. Owned: the app starts the server in its bundle, and the
 * server goes when the app quits or is killed. Update: Sparkle, given a local
 * appcast signed with the release key, offers a newer version and not its
 * own; run `npm run mac:appcast` first for `sign_update`. Needs a login
 * session, so it isn't part of verify. Runs on spare ports with a temporary
 * home, so it touches neither `~/.backstory`, port 4460, nor the login agent.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repoLink } from "../bin/macapp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "build", "Backstory.app");
const executable = path.join(app, "Contents", "MacOS", "Backstory");
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
      res.end(JSON.stringify({ app: "backstory", build: "smoke" }));
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

    const repo = mkdtempSync(path.join(tmpdir(), "backstory smoke c++ & co "));
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
  const home = mkdtempSync(path.join(tmpdir(), "backstory-smoke-home-"));
  const args = ["-port", String(port), "-home", home];
  const log = path.join(home, "server.log");
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
    await withLog(() => waitFor(`Backstory ${version} on :${port}`, up));

    const repo = mkdtempSync(path.join(tmpdir(), "backstory smoke owned "));
    await promisify(execFile)("open", ["-a", app, repoLink(repo)]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (child.exited) throw new Error("the app exited on a backstory:// link");
    if (!(await up()))
      throw new Error("the server went on a backstory:// link");

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

const signUpdate = path.join(
  here,
  "build",
  "sparkle-2.10.0",
  "bin",
  "sign_update",
);

async function checkForUpdates(feed, advertised) {
  const dir = mkdtempSync(path.join(tmpdir(), "backstory-smoke-update-"));
  const archive = path.join(dir, `Backstory-${advertised}.dmg`);
  writeFileSync(archive, "not a real update");
  const { stdout: signature } = await promisify(execFile)(signUpdate, [
    archive,
  ]);
  const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Backstory</title>
    <item>
      <title>${advertised}</title>
      <sparkle:version>${advertised}</sparkle:version>
      <sparkle:shortVersionString>${advertised}</sparkle:shortVersionString>
      <enclosure url="${feed.base}/${path.basename(archive)}" type="application/octet-stream" ${signature.trim()}/>
    </item>
  </channel>
</rss>`;
  feed.appcast = appcast;

  // Attach to the feed server, so the app starts no server of its own and
  // never touches a home.
  const child = spawn(
    executable,
    [
      "-serverURL",
      feed.base,
      "-feedURL",
      `${feed.base}/appcast.xml`,
      "-checkForUpdates",
      "YES",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for the app to quit")),
          30_000,
        ),
      ),
    ]);
  } catch (err) {
    throw new Error(`${err.message}; it logged:\n${log}`);
  } finally {
    child.kill("SIGKILL");
  }
  return log;
}

async function update() {
  if (!existsSync(signUpdate)) {
    throw new Error(`no ${signUpdate} — run npm run mac:appcast first`);
  }
  const feed = { appcast: "" };
  const server = http.createServer((req, res) => {
    if (req.url === "/appcast.xml") {
      res.setHeader("content-type", "application/rss+xml");
      res.end(feed.appcast);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  feed.base = `http://127.0.0.1:${server.address().port}`;
  try {
    const newer = await checkForUpdates(feed, "99.0.0");
    if (!newer.includes("Backstory: update 99.0.0 available")) {
      throw new Error(`no update offered from 99.0.0; it logged:\n${newer}`);
    }
    const same = await checkForUpdates(feed, version);
    if (!same.includes("Backstory: no update")) {
      throw new Error(`an update offered from ${version}; it logged:\n${same}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

let failed = false;
for (const [name, check] of [
  ["attached", attached],
  ["owned", owned],
  ["update", update],
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
