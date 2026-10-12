import assert from "node:assert/strict";
import { test } from "node:test";

import { aiProvider } from "../lib/ai/provider";

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
