#!/usr/bin/env node
/**
 * differ — open a repo in differ's Mac app.
 *
 *   differ              open the cwd's repo
 *   differ <path>       open a specific repo
 *   differ --port N     use the differ on another port, a dev server say
 *                       (default 4460, env DIFFER_PORT), in the browser
 *   differ review [path]
 *                       wait for you to review the uncommitted changes, then
 *                       print your notes to stdout and exit — for an agent
 *                       session to run and read
 *   differ hook stop    the Claude Code Stop hook: hand a finishing session
 *                       any notes queued for it (reads the hook's JSON on
 *                       stdin; silent when there are none or differ is down)
 *
 * The Mac app runs the server; this only ever asks it for things, launching
 * the app when it isn't running (bin/macapp.mjs).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_PORT,
  hookPort,
  readStdin,
  recordPort,
  stopHook,
} from "./hook.mjs";
import { findMacApp, launchPlan, NOT_INSTALLED } from "./macapp.mjs";

// First, before anything that could launch the app or wait on a server: the
// hook runs on every turn of every session and must only ever ask.
if (process.argv[2] === "hook") {
  // A backstop for anything that hangs past the take's own timeout.
  setTimeout(() => process.exit(0), 5000);
  if (process.argv[3] === "stop") {
    await stopHook(await readStdin(), {
      base: `http://127.0.0.1:${hookPort()}`,
    });
  }
  process.exit(0);
}

function parseArgs(argv) {
  const args = { repo: process.cwd(), port: null, review: false };
  if (argv[0] === "review") {
    args.review = true;
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: differ [path] [--port N]\n" +
          "       differ review [path] [--port N]\n" +
          "       differ hook stop   (Claude Code Stop hook; see the README)\n" +
          "Opens the repo (default: cwd) in differ's Mac app, launching it\n" +
          "if it isn't running. With --port, opens the differ on that port\n" +
          "in the browser instead.\n" +
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

/** Whether a *differ* answers on this port, rather than some other server. */
async function differAt(port) {
  try {
    const { body } = await getJson(`http://127.0.0.1:${port}/api/health`);
    return body?.app === "differ";
  } catch {
    return false;
  }
}

async function waitForHealth(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (await differAt(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const args = parseArgs(process.argv.slice(2));
const base = `http://127.0.0.1:${args.port}`;
// In review mode stdout carries only the review — it's what the agent reads.
const say = args.review ? console.error : console.log;
const app = findMacApp();

function fail(message) {
  console.error(`differ: ${message}`);
  process.exit(1);
}

/** The repo's top level, so a subdirectory opens the same repo as its root. */
async function repoRoot(dir) {
  try {
    const { stdout } = await promisify(execFile)("git", [
      "-C",
      dir,
      "rev-parse",
      "--show-toplevel",
    ]);
    return stdout.trim();
  } catch {
    return fail(`not a git repository: ${dir}`);
  }
}

async function openRepo(repo, running) {
  const plan = launchPlan({ repo, port: args.port, app, running });
  if (plan.error) fail(plan.error);
  try {
    await promisify(execFile)("open", plan.open);
  } catch {
    fail(`couldn't open ${plan.open.at(-1)}`);
  }
}

/**
 * `differ review`: ask the server for a review, then wait for it.
 *
 * The wait is a loop of long-polls rather than one request, so no timeout
 * anywhere between here and the server has to be longer than a review takes.
 * Only the answer goes to stdout; everything else is stderr, so an agent that
 * captures stdout reads your notes and nothing else.
 */
async function review() {
  if (!(await differAt(args.port))) {
    if (args.port !== DEFAULT_PORT) {
      fail(`nothing is answering on :${args.port}.`);
    }
    if (!app) fail(NOT_INSTALLED);
    say("differ: starting differ's Mac app…");
    await promisify(execFile)("open", ["-a", app]);
    if (!(await waitForHealth(args.port))) {
      fail(`the Mac app's server didn't come up on :${args.port}.`);
    }
  }

  const enc = encodeURIComponent(args.repo);
  const opened = await getJson(`${base}/api/review?repo=${enc}`, 5000, "POST");
  if (opened.status !== 200) {
    fail(opened.body?.error ?? "not a git repository");
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

  await openRepo(opened.body.repo, true);
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
      // A blip, or the app restarting its server.
      if (++failures > 12) {
        fail("lost the server while waiting for the review.");
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    if (result.status === 404) {
      fail("the review request expired (did differ restart?).");
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
        fail("another `differ review` took over this checkout.");
      default:
        fail(result.body?.error ?? "unexpected response");
    }
  }
}

recordPort(args.port);
if (args.review) await review();

const repo = await repoRoot(args.repo);
await openRepo(repo, await differAt(args.port));
say(`differ: opening ${repo}`);
