import assert from "node:assert/strict";
import { test } from "node:test";

import { pushedState } from "../lib/pushed";
import type { SessionResponse } from "../lib/types";

/** Only the fields pushedState reads. */
function session(over: {
  hasRemote: boolean;
  ref?: string | null;
}): SessionResponse {
  return {
    repo: { ref: over.ref ?? null },
    hasRemote: over.hasRemote,
    commits: [{ sha: "new" }],
    history: [{ sha: "old" }],
  } as unknown as SessionResponse;
}

test("with remotes, the boundary splits pushed from not", () => {
  const s = session({ hasRemote: true });
  assert.equal(pushedState(s, "new"), false);
  assert.equal(pushedState(s, "old"), true);
  assert.equal(pushedState(s, "elsewhere"), null);
});

test("with no remote, nothing has been pushed — history included", () => {
  assert.equal(pushedState(session({ hasRemote: false }), "old"), false);
});

test("a branch reviewed without checking it out can't say", () => {
  const s = session({ hasRemote: true, ref: "feature" });
  assert.equal(pushedState(s, "new"), null);
  assert.equal(pushedState(s, "old"), null);
});
