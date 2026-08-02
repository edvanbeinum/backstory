#!/usr/bin/env node
/**
 * differ — open the current repo in the differ app.
 *
 *   differ              open the cwd's repo
 *   differ <path>       open a specific repo
 *   differ --no-open    make sure the server is running, don't open a window
 *   differ --port N     use a specific port (default 4460, env DIFFER_PORT)
 *
 * One server serves every repo. If a differ is already running (the terminal
 * one, or the `brew services` launchd one), this reuses it: the repo is
 * handed to the running server and the app window/browser is focused on it.
 * Only when nothing is running does this start a server of its own, in the
 * foreground, tied to this terminal.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4460;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const args = { repo: process.cwd(), open: true, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") args.open = false;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: differ [path] [--port N] [--no-open]\n" +
          "Opens the repo (default: cwd) in the differ review app.",
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

async function getJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
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

// 1. Reuse a running differ if there is one.
if (await differRunningAt(args.port)) {
  const enc = encodeURIComponent(args.repo);
  const { status, body } = await getJson(
    `http://127.0.0.1:${args.port}/api/open?repo=${enc}`,
    5000,
  );
  if (status !== 200) {
    console.error(`differ: ${body?.error ?? "not a git repository"}`);
    process.exit(1);
  }
  console.log(`differ already running on :${args.port} — opening ${body.repo}`);
  if (args.open) openWindow(`http://127.0.0.1:${args.port}/`);
  process.exit(0);
}

// 2. Nothing running — start our own, foreground, on this terminal.
const server = findServer();
if (!server) {
  console.error(
    "differ: no server build found. In a checkout, run `npm run build` first.",
  );
  process.exit(1);
}

const child = spawn(server.cmd, server.args, {
  env: {
    ...process.env,
    PORT: String(args.port),
    HOSTNAME: "127.0.0.1", // never expose a server that runs git on request
  },
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

const enc = encodeURIComponent(args.repo);
const { status, body } = await getJson(
  `http://127.0.0.1:${args.port}/api/open?repo=${enc}`,
  5000,
);
if (status === 200) {
  console.log(`differ serving http://127.0.0.1:${args.port} — ${body.repo}`);
} else {
  console.error(`differ: ${body?.error ?? "not a git repository"} (server still running)`);
}
if (args.open) openWindow(`http://127.0.0.1:${args.port}/`);
