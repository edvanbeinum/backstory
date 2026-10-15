import { GITHUB_CLIENT_ID } from "./constants";
import { clearGitHubCache, saveGitHubToken } from "./github";

/**
 * Connect GitHub: GitHub's device flow, one sign-in at a time, held in the
 * server's memory. The page shows the code, the user approves it on
 * github.com, and the poll here saves the token in the Keychain.
 */

export type GitHubLoginState =
  | { state: "idle" }
  | {
      state: "waiting";
      userCode: string;
      verificationUri: string;
      /** Epoch ms */
      expiresAt: number;
    }
  | { state: "connected" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "offline" }
  | { state: "failed"; message: string };

export interface LoginDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const REAL: LoginDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const SLOW_DOWN_STEP_S = 5;

// Kept on globalThis because Next may load this module once per route
// bundle, and GET has to see the sign-in POST started.
const memo = globalThis as {
  __backstoryGitHubLogin?: { current: GitHubLoginState; run: number };
};
const login = (memo.__backstoryGitHubLogin ??= {
  current: { state: "idle" },
  run: 0,
});

export function gitHubLoginState(): GitHubLoginState {
  return login.current;
}

/** Drops any running sign-in and goes back to idle. */
export function resetGitHubLogin() {
  login.run += 1;
  login.current = { state: "idle" };
}

async function post(
  deps: LoginDeps,
  url: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await deps.fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    cache: "no-store",
  });
  return (await response.json()) as Record<string, unknown>;
}

function failure(body: Record<string, unknown>): GitHubLoginState {
  const detail = body.error_description ?? body.error;
  return {
    state: "failed",
    message:
      typeof detail === "string" ? detail : "GitHub didn't accept the sign-in.",
  };
}

/**
 * Asks GitHub for a code and starts polling for the user's answer. Starting
 * again drops the running poll, whose token is then never saved. `started`
 * is the state once GitHub has answered with a code; `finished` settles when
 * the poll ends.
 */
export async function startGitHubLogin(
  overrides: Partial<LoginDeps> = {},
): Promise<{ started: GitHubLoginState; finished: Promise<GitHubLoginState> }> {
  const deps = { ...REAL, ...overrides };
  login.run += 1;
  const run = login.run;
  const settle = (next: GitHubLoginState) => {
    if (login.run === run) login.current = next;
    return login.current;
  };

  let code: Record<string, unknown>;
  try {
    code = await post(deps, "https://github.com/login/device/code", {
      client_id: GITHUB_CLIENT_ID,
      scope: "repo",
    });
  } catch {
    const started = settle({ state: "offline" });
    return { started, finished: Promise.resolve(started) };
  }
  if (
    typeof code.device_code !== "string" ||
    typeof code.user_code !== "string" ||
    typeof code.verification_uri !== "string"
  ) {
    const started = settle(failure(code));
    return { started, finished: Promise.resolve(started) };
  }

  const expiresIn = typeof code.expires_in === "number" ? code.expires_in : 900;
  const started = settle({
    state: "waiting",
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresAt: deps.now() + expiresIn * 1000,
  });
  const interval = typeof code.interval === "number" ? code.interval : 5;
  return {
    started,
    finished: poll(deps, run, code.device_code, interval, started).then(settle),
  };
}

async function poll(
  deps: LoginDeps,
  run: number,
  deviceCode: string,
  firstInterval: number,
  waiting: GitHubLoginState,
): Promise<GitHubLoginState> {
  const expiresAt = waiting.state === "waiting" ? waiting.expiresAt : 0;
  let interval = firstInterval;
  for (;;) {
    await deps.sleep(interval * 1000);
    if (login.run !== run) return login.current;
    if (deps.now() >= expiresAt) return { state: "expired" };

    let body: Record<string, unknown>;
    try {
      body = await post(deps, "https://github.com/login/oauth/access_token", {
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch {
      return { state: "offline" };
    }
    if (login.run !== run) return login.current;

    if (typeof body.access_token === "string") {
      try {
        await saveGitHubToken(body.access_token);
      } catch (err) {
        return {
          state: "failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      clearGitHubCache();
      return { state: "connected" };
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval =
          typeof body.interval === "number"
            ? body.interval
            : interval + SLOW_DOWN_STEP_S;
        continue;
      case "access_denied":
        return { state: "denied" };
      case "expired_token":
        return { state: "expired" };
      default:
        return failure(body);
    }
  }
}
