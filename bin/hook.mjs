/**
 * `differ hook stop` — the Claude Code Stop hook that delivers queued notes.
 *
 * Runs every time any session finishes a turn, so its first duty is to stay
 * out of the way: differ down, unreachable, slow or erroring, a directory
 * that isn't a checkout, input it can't read — every one of those prints
 * nothing and lets the agent stop. It never waits for a person; hooks are
 * killed at their timeout.
 *
 * When differ does have notes for this session, it prints
 * `{"decision": "block", "reason": <notes>}`, which keeps the agent going
 * with the notes as its instructions. Taking them marks them delivered, so
 * the agent's next stop finds nothing and it stops normally — no loop.
 */

/** Well under the hook's timeout, and short enough not to be felt per turn. */
export const TAKE_TIMEOUT_MS = 2000;

/**
 * The hook's output for one Stop event, or "" to let the agent stop.
 * `input` is the raw JSON Claude Code sends on stdin.
 *
 * @param {string} input
 * @param {{ base: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function stopHook(input, { base, timeoutMs = TAKE_TIMEOUT_MS }) {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return "";
  }
  const cwd = event?.cwd;
  const session = event?.session_id;
  if (typeof cwd !== "string" || typeof session !== "string") return "";

  const params = new URLSearchParams({ take: "", cwd, session });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/outbox?${params}`, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return "";
    const body = await response.json();
    if (typeof body?.message !== "string" || !body.message.trim()) return "";
    return JSON.stringify({ decision: "block", reason: body.message });
  } catch {
    return "";
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
