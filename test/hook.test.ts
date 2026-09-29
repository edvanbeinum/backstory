import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { stopHook } from "../bin/hook.mjs";

const INPUT = JSON.stringify({
  session_id: "abc-123",
  cwd: "/repos/app",
  hook_event_name: "Stop",
  stop_hook_active: false,
});

/** A stand-in differ answering the take with `status` and `body`. */
async function differ(
  status: number,
  body: unknown,
  seen: string[] = [],
): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

test("queued notes block the stop and become the agent's instructions", async () => {
  const seen: string[] = [];
  const { base, server } = await differ(200, { message: "## a.ts:3\nfix it\n" }, seen);
  try {
    const out = JSON.parse(await stopHook(INPUT, { base }));
    assert.deepEqual(out, { decision: "block", reason: "## a.ts:3\nfix it\n" });
    const url = new URL(seen[0].split(" ")[1], base);
    assert.equal(seen[0].split(" ")[0], "POST");
    assert.equal(url.searchParams.get("cwd"), "/repos/app");
    assert.equal(url.searchParams.get("session"), "abc-123");
    assert.ok(url.searchParams.has("take"));
  } finally {
    server.close();
  }
});

test("nothing queued prints nothing", async () => {
  const { base, server } = await differ(200, { message: null });
  try {
    assert.equal(await stopHook(INPUT, { base }), "");
  } finally {
    server.close();
  }
});

test("an error from differ — say, not a checkout — prints nothing", async () => {
  const { base, server } = await differ(400, { error: "Not a git repository" });
  try {
    assert.equal(await stopHook(INPUT, { base }), "");
  } finally {
    server.close();
  }
});

test("differ not running prints nothing", async () => {
  // Grab a port, then free it, so nothing is listening there.
  const { base, server } = await differ(200, {});
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await stopHook(INPUT, { base }), "");
});

test("a differ that hangs is given up on at the timeout", async () => {
  const server = createServer(() => {
    // never answers
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  try {
    const out = await stopHook(INPUT, { base: `http://127.0.0.1:${port}`, timeoutMs: 200 });
    assert.equal(out, "");
    assert.ok(Date.now() - started < 1500);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("input it can't read prints nothing", async () => {
  assert.equal(await stopHook("not json", { base: "http://127.0.0.1:1" }), "");
  assert.equal(await stopHook("{}", { base: "http://127.0.0.1:1" }), "");
});
