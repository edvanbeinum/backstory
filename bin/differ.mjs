#!/usr/bin/env node
/**
 * differ — open the current repo in the differ app.
 *
 *   differ              open the cwd's repo
 *   differ <path>       open a specific repo
 *   differ --no-open    make sure the server is running, don't open a window
 *   differ --port N     use a specific port (default 4460, env DIFFER_PORT)
 *                       (the installed app window is used on the default port;
 *                       env DIFFER_APP points at a different app)
 *   differ review [path]
 *                       wait for you to review the uncommitted changes, then
 *                       print your notes to stdout and exit — for an agent
 *                       session to run and read
 *   differ install      (re)install the login agent and restart the server
 *   differ uninstall    stop the server and remove the login agent
 *   differ --foreground run the server in this terminal instead
 *
 * One server serves every repo. If a differ is already running (the login
 * agent, the `brew services` one, or a terminal's), this reuses it: the repo
 * is handed to the running server and the app window/browser is focused on
 * it. When nothing is running, on macOS this installs a login agent that
 * keeps a server running from then on (bin/launchd.mjs); elsewhere, or with
 * --foreground, it starts one tied to this terminal.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as launchd from "./launchd.mjs";

const DEFAULT_PORT = 4460;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    open: true,
    port: null,
    review: false,
    command: null,
    foreground: false,
  };
  if (argv[0] === "review") {
    args.review = true;
    argv = argv.slice(1);
  } else if (argv[0] === "install" || argv[0] === "uninstall") {
    args.command = argv[0];
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") args.open = false;
    else if (a === "--foreground") args.foreground = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: differ [path] [--port N] [--no-open] [--foreground]\n" +
          "       differ review [path] [--port N] [--no-open]\n" +
          "       differ install [--port N] | differ uninstall\n" +
          "Opens the repo (default: cwd) in the differ review app.\n" +
          "`review` then waits for you to send notes on the uncommitted\n" +
          "changes, prints them to stdout, and exits.\n" +
          "On macOS the server runs as a login agent, installed on first use.",
      );
      process.exit(0);
    } else if (!a.startsWith("-")) args.repo = path.resolve(a);
    else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  args.port ??= Number(process.env.DIFFER_PORT) || DEFAULT_PORT;
  return args;
}

async function getJson(url, timeoutMs = 1500, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health of a *differ* answering on this port (vs some unrelated dev
 * server), or null.
 */
async function differAt(port) {
  try {
    const { body } = await getJson(`http://127.0.0.1:${port}/api/health`);
    return body?.app === "differ" ? body : null;
  } catch {
    return null;
  }
}

/**
 * The installed app window — Chrome's "Install page as app" or Safari's "Add
 * to Dock" — if there is one for this port. `open <url>` only ever reaches the
 * default browser, even with the app already running, so the app has to be
 * launched by name. It opens at its start_url and collects the repo from the
 * /api/open handoff, like any other launch.
 *
 * Only on the default port: the app is bound to the address it was installed
 * from, and launching it for another port would show a different server.
 * DIFFER_APP names an app explicitly.
 */
function findApp(port) {
  if (process.env.DIFFER_APP) return process.env.DIFFER_APP;
  if (port !== DEFAULT_PORT) return null;
  const apps = path.join(homedir(), "Applications");
  return (
    [
      path.join(apps, "Chrome Apps.localized", "differ.app"),
      path.join(apps, "differ.app"),
    ].find((p) => existsSync(p)) ?? null
  );
}

function openWindow(url) {
  const inBrowser = () =>
    execFile("open", [url], (err) => {
      if (err) console.error(`couldn't open a browser — visit ${url}`);
    });

  const app = findApp(args.port);
  if (!app) return inBrowser();
  execFile("open", ["-a", app], (err) => {
    if (err) inBrowser();
  });
}

/** The standalone server.js to run, or null when there's no build. */
function findServer() {
  // Homebrew layout: bin/differ.mjs next to a standalone build.
  const standalone = path.join(APP_ROOT, "standalone", "server.js");
  if (existsSync(standalone)) return standalone;
  // Repo checkout: the postbuild step assembles .next/standalone.
  const local = path.join(APP_ROOT, ".next", "standalone", "server.js");
  if (existsSync(local)) return local;
  return null;
}

/** The build a fresh server would run — what /api/health reports as `build`. */
function builtId(server) {
  try {
    return readFileSync(path.join(path.dirname(server), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Wait for a differ on `port`, optionally one running a particular build. */
async function waitForHealth(port, build = null, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const health = await differAt(port);
    if (health && (build === null || health.build === build)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const args = parseArgs(process.argv.slice(2));
const base = `http://127.0.0.1:${args.port}`;
// In review mode stdout carries only the review — it's what the agent reads.
const say = args.review ? console.error : console.log;

/** Park the repo for the app window, and bring the window up. */
async function handOff() {
  const enc = encodeURIComponent(args.repo);
  const { status, body } = await getJson(`${base}/api/open?repo=${enc}`, 5000);
  if (status !== 200) {
    console.error(`differ: ${body?.error ?? "not a git repository"}`);
    return null;
  }
  if (args.open) openWindow(`${base}/`);
  return body.repo;
}

function differHome() {
  return process.env.DIFFER_HOME || path.join(homedir(), ".differ");
}

/**
 * `differ review`: ask the running server for a review, then wait for it.
 *
 * The wait is a loop of long-polls rather than one request, so no timeout
 * anywhere between here and the server has to be longer than a review takes.
 * Only the answer goes to stdout; everything else is stderr, so an agent that
 * captures stdout reads your notes and nothing else.
 */
async function review() {
  const enc = encodeURIComponent(args.repo);
  const opened = await getJson(`${base}/api/review?repo=${enc}`, 5000, "POST");
  if (opened.status !== 200) {
    console.error(`differ: ${opened.body?.error ?? "not a git repository"}`);
    process.exit(1);
  }
  const { id } = opened.body;

  // Stopped from outside (Ctrl-C, the agent killing its task): tell the
  // window, so it stops offering to send to nobody.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, async () => {
      try {
        await getJson(`${base}/api/review?id=${id}`, 1500, "DELETE");
      } catch {
        // server gone too — nothing to tell
      }
      process.exit(130);
    });
  }

  if (!(await handOff())) process.exit(1);
  console.error(
    `differ: waiting for your review of ${opened.body.repo} — ` +
      "leave notes on its changes and press Send to agent.",
  );

  let failures = 0;
  for (;;) {
    let result;
    try {
      result = await getJson(`${base}/api/review?id=${id}`, 40_000);
      failures = 0;
    } catch {
      // A blip, or the server restarting.
      if (++failures > 12) {
        console.error("differ: lost the server while waiting for the review.");
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    if (result.status === 404) {
      console.error("differ: the review request expired (did differ restart?).");
      process.exit(1);
    }
    switch (result.body?.state) {
      case "waiting":
        continue;
      case "answered":
        process.stdout.write(result.body.answer);
        process.exit(0);
      case "dismissed":
        process.stdout.write(
          "The reviewer dismissed the review without leaving feedback.\n",
        );
        process.exit(0);
      case "superseded":
        console.error("differ: another `differ review` took over this checkout.");
        process.exit(1);
      default:
        console.error(`differ: ${result.body?.error ?? "unexpected response"}`);
        process.exit(1);
    }
  }
}

const server = findServer();
const serverLog = path.join(differHome(), "server.log");

/** The login agent's plist, for this build on this port. */
function agentSpec() {
  return {
    server,
    port: args.port,
    pathEnv: process.env.PATH ?? "",
    log: serverLog,
    differHome: process.env.DIFFER_HOME,
  };
}

/**
 * Whether the login agent should own the server on this port. Not when
 * Homebrew's service does, and not for a port other than the one an installed
 * agent already serves — the window open on that port would lose its server.
 */
function agentManaged() {
  if (!launchd.supported() || args.foreground) return false;
  if (launchd.brewServiceInstalled()) return false;
  const port = launchd.installedPort();
  return port === null || port === args.port;
}

function requireServer() {
  if (server) return;
  console.error(
    "differ: no server build found. In a checkout, run `npm run build` first.",
  );
  process.exit(1);
}

if (args.command === "uninstall") {
  const had = launchd.supported() && (await launchd.uninstallAgent());
  console.log(had ? "differ: login agent removed, server stopped." : "differ: no login agent installed.");
  process.exit(0);
}

if (args.command === "install") {
  if (!launchd.supported()) {
    console.error("differ: the login agent is macOS only.");
    process.exit(1);
  }
  requireServer();
  // Reinstalling is also how to restart onto a rebuild.
  if ((await launchd.ensureAgent(agentSpec())) === "started") await launchd.restartAgent();
  if (!(await waitForHealth(args.port, builtId(server)))) {
    console.error(`differ: server didn't come up on :${args.port} — see ${serverLog}`);
    process.exit(1);
  }
  console.log(`differ: login agent installed — serving ${base} (log: ${serverLog})`);
  process.exit(0);
}

const running = await differAt(args.port);

// A server that outlives every terminal also outlives rebuilds; without this
// it would serve the old build until the next login.
if (
  running &&
  server &&
  launchd.installedPort() === args.port &&
  agentManaged() &&
  (await launchd.agentLoaded())
) {
  const build = builtId(server);
  if (build && running.build !== build) {
    say(`differ: restarting the server onto the new build…`);
    if ((await launchd.ensureAgent(agentSpec())) === "started") await launchd.restartAgent();
    if (!(await waitForHealth(args.port, build))) {
      console.error(`differ: server didn't come back on :${args.port} — see ${serverLog}`);
      process.exit(1);
    }
  }
}

if (running) {
  if (args.review) await review();
  const repo = await handOff();
  if (!repo) process.exit(1);
  say(`differ already running on :${args.port} — opening ${repo}`);
  process.exit(0);
}

requireServer();

if (agentManaged()) {
  const result = await launchd.ensureAgent(agentSpec());
  if (result === "installed") {
    say(
      "differ: installed a login agent, so the server now starts on its own — " +
        "`differ uninstall` removes it.",
    );
  }
  if (!(await waitForHealth(args.port))) {
    console.error(`differ: server didn't come up on :${args.port} — see ${serverLog}`);
    process.exit(1);
  }
  if (args.review) await review();
  const repo = await handOff();
  if (!repo) process.exit(1);
  say(`differ serving ${base} — ${repo}`);
  process.exit(0);
}

const env = {
  ...process.env,
  PORT: String(args.port),
  HOSTNAME: "127.0.0.1", // never expose a server that runs git on request
};

if (args.review) {
  // Detached: `differ review` exits the moment you answer, and the window
  // you're answering in mustn't die with it. The next `differ` reuses it.
  mkdirSync(differHome(), { recursive: true });
  const log = openSync(serverLog, "a");
  const child = spawn("node", [server], {
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!(await waitForHealth(args.port))) {
    console.error(`differ: server didn't come up on :${args.port} — see ${serverLog}`);
    process.exit(1);
  }
  await review();
}

const child = spawn("node", [server], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

if (!(await waitForHealth(args.port))) {
  console.error(`differ: server didn't come up on :${args.port}`);
  child.kill("SIGTERM");
  process.exit(1);
}

const repo = await handOff();
if (repo) console.log(`differ serving ${base} — ${repo}`);
else console.error("differ: (server still running)");
