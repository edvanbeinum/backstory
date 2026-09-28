#!/usr/bin/env node
/**
 * differ — open the current repo in the differ app.
 *
 *   differ              open the cwd's repo
 *   differ <path>       open a specific repo
 *   differ --no-open    make sure the server is running, don't open a window
 *   differ --port N     use a specific port (default 4460, env DIFFER_PORT)
 *   differ review [path]
 *                       wait for you to review the uncommitted changes, then
 *                       print your notes to stdout and exit — for an agent
 *                       session to run and read
 *
 * One server serves every repo. If a differ is already running (the terminal
 * one, or the `brew services` launchd one), this reuses it: the repo is
 * handed to the running server and the app window/browser is focused on it.
 * Only when nothing is running does this start a server of its own, in the
 * foreground, tied to this terminal.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4460;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const args = { repo: process.cwd(), open: true, port: null, review: false };
  if (argv[0] === "review") {
    args.review = true;
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") args.open = false;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: differ [path] [--port N] [--no-open]\n" +
          "       differ review [path] [--port N] [--no-open]\n" +
          "Opens the repo (default: cwd) in the differ review app.\n" +
          "`review` then waits for you to send notes on the uncommitted\n" +
          "changes, prints them to stdout, and exits.",
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

/** Is a *differ* answering on this port (vs some unrelated dev server)? */
async function differRunningAt(port) {
  try {
    const { body } = await getJson(`http://127.0.0.1:${port}/api/health`);
    return body?.app === "differ";
  } catch {
    return false;
  }
}

function openWindow(url) {
  // `open` uses the default browser; the installed app window (Chrome
  // "Install page as app" / Safari "Add to Dock") is focused by the OS when
  // its origin is already open there. Either way a window appears.
  execFile("open", [url], (err) => {
    if (err) console.error(`couldn't open a browser — visit ${url}`);
  });
}

function findServer() {
  // Homebrew layout: bin/differ.mjs next to a standalone build.
  const standalone = path.join(APP_ROOT, "standalone", "server.js");
  if (existsSync(standalone)) return { cmd: "node", args: [standalone] };
  // Repo checkout: the postbuild step assembles .next/standalone.
  const local = path.join(APP_ROOT, ".next", "standalone", "server.js");
  if (existsSync(local)) return { cmd: "node", args: [local] };
  return null;
}

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await differRunningAt(port)) return true;
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
      "leave notes on the Uncommitted changes and press Send to agent.",
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

if (await differRunningAt(args.port)) {
  if (args.review) await review();
  const repo = await handOff();
  if (!repo) process.exit(1);
  say(`differ already running on :${args.port} — opening ${repo}`);
  process.exit(0);
}

const server = findServer();
if (!server) {
  console.error(
    "differ: no server build found. In a checkout, run `npm run build` first.",
  );
  process.exit(1);
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
  const log = openSync(path.join(differHome(), "server.log"), "a");
  const child = spawn(server.cmd, server.args, {
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!(await waitForHealth(args.port))) {
    console.error(
      `differ: server didn't come up on :${args.port} — see ${path.join(differHome(), "server.log")}`,
    );
    process.exit(1);
  }
  await review();
}

const child = spawn(server.cmd, server.args, {
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
