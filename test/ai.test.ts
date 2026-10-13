import assert from "node:assert/strict";
import { test } from "node:test";

import { aiProvider } from "../lib/ai/provider";
import { quietLoginShell, standIns } from "./standins";

quietLoginShell();

function withAi<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.BACKSTORY_AI;
  if (value === undefined) delete process.env.BACKSTORY_AI;
  else process.env.BACKSTORY_AI = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.BACKSTORY_AI;
    else process.env.BACKSTORY_AI = saved;
  }
}

test("the AI provider is Claude Code by default and by its id", () => {
  assert.equal(
    withAi(undefined, () => aiProvider().id),
    "claude",
  );
  assert.equal(
    withAi("claude", () => aiProvider().name),
    "Claude Code",
  );
});

test("an unknown BACKSTORY_AI names the providers there are", () => {
  assert.throws(
    () => withAi("grok", () => aiProvider()),
    /"grok".*one of: claude\./,
  );
});

/** A `claude` whose `auth status` prints `auth` and exits `code`. */
const claude = (auth: string, code = 0) =>
  standIns({
    claude: `if [ "$1" = auth ]; then echo '${auth}'; exit ${code}; fi\necho "2.1.0 (Claude Code)"`,
  });

async function statusWith(dir: string) {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await aiProvider().status();
  } finally {
    process.env.PATH = saved;
  }
}

test("Claude Code reads as missing, logged out or ready", async () => {
  assert.equal(await statusWith(standIns({})), "missing");
  assert.equal(
    await statusWith(claude('{"loggedIn": false, "authMethod": "none"}', 1)),
    "logged-out",
  );
  assert.equal(
    await statusWith(claude('{"loggedIn": true, "authMethod": "claude.ai"}')),
    "ready",
  );
});

test("an auth status with no JSON in it reads as ready, so an odd version can't block a working setup", async () => {
  assert.equal(
    await statusWith(claude("error: unknown command 'auth'", 1)),
    "ready",
  );
});
