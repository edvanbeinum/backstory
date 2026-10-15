import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { forgetGitHubToken } from "../lib/github";
import {
  resetGitHubLogin,
  startGitHubLogin,
  type LoginDeps,
} from "../lib/githubLogin";
import { SECURITY, standIns } from "./standins";

const TOKEN = "gho_approvedToken456";

const CODE = {
  device_code: "dev-1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

/**
 * A sign-in driven by canned answers to each poll, then `rest` for every poll
 * after them, with no network and no waiting: the clock moves only by the
 * delays asked for, which `sleeps` records.
 */
async function signIn(
  polls: Array<Record<string, unknown> | "throw">,
  opts: {
    code?: Record<string, unknown> | "throw";
    rest?: Record<string, unknown> | "throw";
  } = {},
) {
  const dir = standIns({ security: SECURITY });
  const saved = process.env.PATH;
  process.env.PATH = dir;
  const sleeps: number[] = [];
  const answers = [opts.code ?? CODE, ...polls];
  const deps: LoginDeps = {
    fetch: async () => {
      const next = answers.shift() ??
        opts.rest ?? { error: "authorization_pending" };
      if (next === "throw") throw new TypeError("fetch failed");
      return Response.json(next);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => sleeps.reduce((sum, ms) => sum + ms, 0),
  };
  try {
    const { started, finished } = await startGitHubLogin(deps);
    const state = await finished;
    const keychain = path.join(dir, "keychain");
    return {
      started,
      state,
      sleeps,
      token: existsSync(keychain) ? readFileSync(keychain, "utf8") : null,
      argv: existsSync(path.join(dir, "security.log"))
        ? readFileSync(path.join(dir, "security.log"), "utf8")
        : "",
    };
  } finally {
    process.env.PATH = saved;
  }
}

test("approved after one pending poll, the token is saved in the Keychain and never in argv", async () => {
  const run = await signIn([
    { error: "authorization_pending" },
    { access_token: TOKEN, token_type: "bearer", scope: "repo" },
  ]);
  assert.deepEqual(run.started, {
    state: "waiting",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: 900_000,
  });
  assert.deepEqual(run.state, { state: "connected" });
  assert.equal(run.token, TOKEN);
  assert.deepEqual(run.sleeps, [5000, 5000]);
  assert.ok(!run.argv.includes(TOKEN));
});

test("denying the code on GitHub saves nothing", async () => {
  const run = await signIn([{ error: "access_denied" }]);
  assert.deepEqual(run.state, { state: "denied" });
  assert.equal(run.token, null);
});

test("a code left too long expires", async () => {
  const run = await signIn([{ error: "expired_token" }]);
  assert.deepEqual(run.state, { state: "expired" });
});

test("slow_down waits the interval GitHub asks for", async () => {
  const run = await signIn([
    { error: "slow_down", interval: 10 },
    { access_token: TOKEN },
  ]);
  assert.deepEqual(run.sleeps, [5000, 10_000]);
  assert.deepEqual(run.state, { state: "connected" });
});

test("no network is offline when asking for the code, or when it lasts until the code expires", async () => {
  assert.deepEqual((await signIn([], { code: "throw" })).state, {
    state: "offline",
  });
  assert.deepEqual((await signIn([], { rest: "throw" })).state, {
    state: "offline",
  });
});

test("a failed poll keeps the sign-in going, so an approval that follows still connects", async () => {
  const run = await signIn(["throw", { access_token: TOKEN }]);
  assert.deepEqual(run.state, { state: "connected" });
  assert.equal(run.token, TOKEN);
});

test("an app with the device flow off fails with GitHub's reason", async () => {
  const run = await signIn([], {
    code: {
      error: "device_flow_disabled",
      error_description: "Device Flow must be explicitly enabled for this App",
    },
  });
  assert.deepEqual(run.state, {
    state: "failed",
    message: "Device Flow must be explicitly enabled for this App",
  });
  const polled = await signIn([{ error: "incorrect_client_id" }]);
  assert.equal(polled.state.state, "failed");
});

test("starting a second sign-in drops the first, whose token is never saved", async () => {
  const dir = standIns({ security: SECURITY });
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = await startGitHubLogin({
      fetch: async (_url, init) =>
        Response.json(
          String(init?.body).includes("device_code=")
            ? { access_token: "gho_firstToken" }
            : CODE,
        ),
      sleep: () => held,
      now: () => 0,
    });
    const second = await startGitHubLogin({
      fetch: async () => Response.json(CODE),
      sleep: () => new Promise(() => {}),
      now: () => 0,
    });
    release();
    await first.finished;

    assert.equal(second.started.state, "waiting");
    assert.equal(existsSync(path.join(dir, "keychain")), false);
  } finally {
    process.env.PATH = saved;
  }
});

test("Disconnect GitHub while the token is being saved leaves no token behind", async () => {
  // A `security` whose save waits for the test to say go, so the Disconnect
  // lands mid-save
  const dir = standIns({
    security: SECURITY.replace(
      "-i) read -r line;",
      '-i) read -r line; touch "$dir/saving"; while [ ! -f "$dir/go" ]; do sleep 0.02; done;',
    ),
  });
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    const { finished } = await startGitHubLogin({
      fetch: async (_url, init) =>
        Response.json(
          String(init?.body).includes("device_code=")
            ? { access_token: TOKEN }
            : CODE,
        ),
      sleep: async () => {},
      now: () => 0,
    });
    while (!existsSync(path.join(dir, "saving"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    resetGitHubLogin();
    await forgetGitHubToken();
    writeFileSync(path.join(dir, "go"), "");

    assert.deepEqual(await finished, { state: "idle" });
    assert.equal(existsSync(path.join(dir, "keychain")), false);
  } finally {
    process.env.PATH = saved;
  }
});
