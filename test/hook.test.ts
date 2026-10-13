import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_PORT, hookPort, recordPort, stopHook } from "../bin/hook.mjs";

const INPUT = JSON.stringify({
  session_id: "abc-123",
  cwd: "/repos/app",
  hook_event_name: "Stop",
  stop_hook_active: false,
});

/** A stand-in Backstory answering the take with `status` and `body`. */
async function backstory(
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
  const printed: string[] = [];
  const { base, server } = await backstory(
    200,
    { message: "## a.ts:3\nfix it\n", ids: ["r1"] },
    seen,
  );
  try {
    const out = await stopHook(INPUT, {
      base,
      print: (o: string) => printed.push(o),
    });
    assert.deepEqual(JSON.parse(out), {
      decision: "block",
      reason: "## a.ts:3\nfix it\n",
    });
    assert.deepEqual(printed, [out]);
    const url = new URL(seen[0].split(" ")[1], base);
    assert.equal(seen[0].split(" ")[0], "POST");
    assert.equal(url.searchParams.get("cwd"), "/repos/app");
    assert.equal(url.searchParams.get("session"), "abc-123");
    assert.ok(url.searchParams.has("take"));
    // Then it says it printed them, which is what marks them delivered.
    assert.ok(new URL(seen[1].split(" ")[1], base).searchParams.has("ack"));
  } finally {
    server.close();
  }
});

test("the notes are printed even when the confirmation fails", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(calls === 1 ? 200 : 500, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(calls === 1 ? { message: "fix it", ids: ["r1"] } : {}),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const printed: string[] = [];
  try {
    await stopHook(INPUT, {
      base: `http://127.0.0.1:${port}`,
      print: (o: string) => printed.push(o),
    });
    assert.equal(printed.length, 1);
  } finally {
    server.close();
  }
});

test("the hook finds the port Backstory was last started on", () => {
  const env: Record<string, string> = {
    BACKSTORY_HOME: mkdtempSync(path.join(tmpdir(), "backstory-hook-")),
  };
  assert.equal(hookPort(env), DEFAULT_PORT);
  recordPort(4555, env);
  assert.equal(hookPort(env), 4555);
  // The agent's own BACKSTORY_PORT still wins.
  assert.equal(hookPort({ ...env, BACKSTORY_PORT: "4600" }), 4600);
});

test("nothing queued prints nothing", async () => {
  const { base, server } = await backstory(200, { message: null });
  try {
    assert.equal(await stopHook(INPUT, { base }), "");
  } finally {
    server.close();
  }
});

test("an error from Backstory — say, not a checkout — prints nothing", async () => {
  const { base, server } = await backstory(400, {
    error: "Not a git repository",
  });
  try {
    assert.equal(await stopHook(INPUT, { base }), "");
  } finally {
    server.close();
  }
});

test("Backstory not running prints nothing", async () => {
  // Grab a port, then free it, so nothing is listening there.
  const { base, server } = await backstory(200, {});
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await stopHook(INPUT, { base }), "");
});

test("a Backstory that hangs is given up on at the timeout", async () => {
  const server = createServer(() => {
    // never answers
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  try {
    const out = await stopHook(INPUT, {
      base: `http://127.0.0.1:${port}`,
      timeoutMs: 200,
    });
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
