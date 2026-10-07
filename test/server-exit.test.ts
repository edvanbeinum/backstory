import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";

import { root } from "./yaml";

const preload = path.join(root, "mac", "server-exit-with-parent.cjs");

// Starts a stand-in for the Mac app, which starts a stand-in server with the
// preload and prints its pid. The test only ever signals the stand-in app.
async function startApp(exitAfterStarting: boolean) {
  const script = `
    const { spawn } = require("node:child_process");
    const server = spawn(process.execPath, ["--require", ${JSON.stringify(preload)}, "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    server.unref();
    console.log(server.pid);
    ${exitAfterStarting ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
  `;
  const app = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = (await once(app.stdout, "data")) as [Buffer];
  return { app, server: Number(line.toString().trim()) };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("the server exits soon after the app that started it is gone", async () => {
  const { server } = await startApp(true);
  assert.ok(await goneWithin(server, 5000), "the server outlived the app");
});

test("the server keeps running while the app that started it is alive", async () => {
  const { app, server } = await startApp(false);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.ok(alive(server), "the server exited with its app still running");
  app.kill();
  assert.ok(await goneWithin(server, 5000), "the server outlived the app");
});
