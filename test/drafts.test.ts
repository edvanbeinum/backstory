import assert from "node:assert/strict";
import { test } from "node:test";

import {
  confirmedDrafts,
  keyFor,
  withDrafts,
  type PendingDraft,
} from "../lib/drafts";
import type { ReviewThread, SessionResponse } from "../lib/types";

const KEY = "acme/widgets#42";

function thread(id: string, reply: string | null = null): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 1,
    originalLine: 1,
    startLine: null,
    side: "RIGHT",
    comments: [],
    response: { done: false, doneAt: null, reply, commits: [] },
  };
}

/** Only the fields these two functions read; the rest is never touched. */
function session(threads: ReviewThread[], pr = 42): SessionResponse {
  return {
    repo: { owner: "acme", name: "widgets" },
    github: { pr: { number: pr }, threads },
  } as unknown as SessionResponse;
}

const pending = (text: string | null, key = KEY): PendingDraft => ({
  key,
  text,
});

test("the store's key is read off the session", () => {
  assert.equal(keyFor(session([])), KEY);
  assert.equal(keyFor(null), null);
  // No pull request, no place to file a response.
  assert.equal(keyFor({ ...session([]), github: { pr: null } } as never), null);
});

test("a refresh can't echo an empty box over what you just typed", () => {
  // What the server knows: nothing yet — the write hasn't landed.
  const fresh = session([thread("t1"), thread("t2")]);
  const drafts = new Map([["t1", pending("half a sentence")]]);

  const merged = withDrafts(fresh, drafts, KEY);
  assert.equal(merged.github.threads[0].response.reply, "half a sentence");
  assert.equal(merged.github.threads[1].response.reply, null);
});

test("an unacknowledged clear survives a refresh too", () => {
  const fresh = session([thread("t1", "the old text")]);
  const drafts = new Map([["t1", pending(null)]]);

  const merged = withDrafts(fresh, drafts, KEY);
  assert.equal(merged.github.threads[0].response.reply, null);
});

test("a draft belongs to the pull request it was typed on", () => {
  const other = session([thread("t1", "what the store holds")], 43);
  const drafts = new Map([["t1", pending("typed on #42")]]);

  const merged = withDrafts(other, drafts, keyFor(other));
  assert.equal(merged.github.threads[0].response.reply, "what the store holds");
});

test("a written draft is only let go once a load agrees with it", () => {
  const written = { ...pending("mine"), saved: true };
  const drafts = new Map([["t1", written]]);

  // The read that was already in flight when the write landed: it carries the
  // older text, and letting go here is exactly how the box goes blank.
  const stale = session([thread("t1", null)]);
  assert.deepEqual(confirmedDrafts(stale, drafts, KEY), []);
  assert.equal(
    withDrafts(stale, drafts, KEY).github.threads[0].response.reply,
    "mine",
  );

  const caughtUp = session([thread("t1", "mine")]);
  assert.deepEqual(confirmedDrafts(caughtUp, drafts, KEY), ["t1"]);
});

test("a draft still waiting on its write is never confirmed", () => {
  const drafts = new Map([["t1", pending("mine")]]);
  // Even against data that happens to match — that text got there some other
  // way, and this one still has a write owed to it.
  assert.deepEqual(confirmedDrafts(session([thread("t1", "mine")]), drafts, KEY), []);
});

test("everything else in the session comes through untouched", () => {
  const fresh = session([thread("t1")]);
  assert.equal(withDrafts(fresh, new Map(), KEY), fresh);

  const merged = withDrafts(fresh, new Map([["t1", pending("mine")]]), KEY);
  assert.equal(merged.repo, fresh.repo);
  assert.equal(merged.github.threads[0].response.done, false);
  assert.deepEqual(merged.github.threads[0].comments, []);
});
