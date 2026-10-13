/**
 * `backstory hook stop` — the Claude Code Stop hook that delivers queued notes.
 *
 * Runs every time any session finishes a turn, so its first duty is to stay
 * out of the way: Backstory down, unreachable, slow or erroring, a directory
 * that isn't a checkout, input it can't read — every one of those prints
 * nothing and lets the agent stop. It never waits for a person; hooks are
 * killed at their timeout.
 *
 * When Backstory does have notes for this session, it prints
 * `{"decision": "block", "reason": <notes>}`, which keeps the agent going
 * with the notes as its instructions, then tells Backstory it did. Only that
 * marks them delivered: a hook that gave up before the answer came leaves
 * them to be taken again, never lost. Once delivered, the agent's next stop
 * finds nothing and it stops normally — no loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 4460;

const home = (env) => env.BACKSTORY_HOME || path.join(homedir(), ".backstory");

const portFile = (env) => path.join(home(env), "port");

/**
 * Note the port a server was last reached on. A hook runs in the agent's
 * environment, not the one `backstory --port N` ran in, so it can't be told.
 *
 * @param {number} port
 * @param {Record<string, string | undefined>} env
 */
export function recordPort(port, env = process.env) {
  try {
    mkdirSync(home(env), { recursive: true });
    writeFileSync(portFile(env), `${port}\n`);
  } catch {
    // The hook falls back to the default port; nothing worse.
  }
}

/**
 * Where the hook finds Backstory: BACKSTORY_PORT, else the last one recorded.
 *
 * @param {Record<string, string | undefined>} env
 */
export function hookPort(env = process.env) {
  if (Number(env.BACKSTORY_PORT)) return Number(env.BACKSTORY_PORT);
  try {
    return Number(readFileSync(portFile(env), "utf8").trim()) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Whether a Stop hook's command is this one: the whole command is
 * `backstory hook stop`, bare or as a path, quoted or not. A command that
 * chains it after something else, like `notify-me && backstory hook stop`, is
 * the user's, so setup and undo never rewrite or delete their part.
 * `backstory setup claude` and the setup checklist's Notes to your agent row
 * both use it, so a hook setup writes ticks the row.
 *
 * @param {unknown} command
 */
export function isBackstoryHook(command) {
  return typeof command === "string" && BACKSTORY_HOOK.test(command);
}

// The program is a single-quoted path (with `'\''` for a quote, as
// shellQuote writes it), a double-quoted one, or a bare word.
const BACKSTORY_HOOK =
  /^\s*(?:'(?:(?:[^']|'\\'')*\/)?backstory'|"(?:[^"]*\/)?backstory"|(?:[^\s'"]*\/)?backstory)\s+hook\s+stop\s*$/;

/** Well under the hook's timeout, and short enough not to be felt per turn. */
export const TAKE_TIMEOUT_MS = 2000;

/**
 * Handle one Stop event: print the notes for this session, if there are any.
 * Returns what it printed, or "" to let the agent stop. `input` is the raw
 * JSON Claude Code sends on stdin.
 *
 * @param {string} input
 * @param {{ base: string, timeoutMs?: number, print?: (out: string) => void }} options
 * @returns {Promise<string>}
 */
export async function stopHook(
  input,
  {
    base,
    timeoutMs = TAKE_TIMEOUT_MS,
    print = (out) => process.stdout.write(out + "\n"),
  },
) {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return "";
  }
  const cwd = event?.cwd;
  const session = event?.session_id;
  if (typeof cwd !== "string" || typeof session !== "string") return "";

  const url = (op) =>
    `${base}/api/outbox?${new URLSearchParams({ [op]: "", cwd, session })}`;
  let taken;
  try {
    taken = await post(url("take"), null, timeoutMs);
  } catch {
    return "";
  }
  if (typeof taken?.message !== "string" || !taken.message.trim()) return "";

  const out = JSON.stringify({ decision: "block", reason: taken.message });
  print(out);
  // After printing, so a lost answer means the notes come again, not never.
  try {
    await post(
      url("ack"),
      { ids: Array.isArray(taken.ids) ? taken.ids : [] },
      timeoutMs,
    );
  } catch {
    // They stay claimed, and are taken again once the claim lapses.
  }
  return out;
}

/** POST to Backstory and read the JSON answer; throws on anything but a 2xx. */
async function post(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      ...(body && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) throw new Error(`Backstory answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Everything on stdin, or "" if it doesn't arrive in time. */
export function readStdin(stream = process.stdin, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (stream.isTTY) return resolve("");
    let data = "";
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", done);
    stream.on("error", done);
  });
}
