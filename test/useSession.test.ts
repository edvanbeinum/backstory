import {
  FakeEventSource,
  act,
  installEventSource,
  renderHook,
  settle,
  standInFetch,
  type FetchAnswer,
  type FetchCall,
} from "./render";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useSession } from "../components/useSession";
import type { SessionResponse } from "../lib/types";

const SHA = "a".repeat(40);
const PASTED = "f".repeat(40);

function sessionFor(
  root: string,
  over: { branch?: string; hasChanges?: boolean; threads?: string[] } = {},
): SessionResponse {
  return {
    repo: { root, branch: over.branch ?? "main" },
    base: { sha: "b".repeat(40) },
    commits: [{ sha: SHA }],
    history: [],
    working: { hasChanges: over.hasChanges ?? false },
    github: { threads: (over.threads ?? []).map((id) => ({ id })) },
    branchDiff: null,
  } as unknown as SessionResponse;
}

/**
 * Mounts the hook with stand-ins for the URL hook's setters and the page's
 * callbacks, answering `/api/session` with `answer`.
 */
async function mount(
  answer: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer>,
  over: Partial<{ repo: string; ref: string | null; comment: string }> = {},
) {
  const calls = standInFetch({
    "/api/session": answer,
    "/api/looked": { json: {} },
    "/api/health": { json: { build: "b1" } },
  });
  const url = { rev: "working", comment: over.comment ?? null };
  const opened: Array<[string, string | null]> = [];
  const gone: string[] = [];
  const props = {
    repo: over.repo ?? "/repos/a",
    ref: over.ref ?? null,
    ready: true,
    setRev: (update: (current: string) => string) => {
      url.rev = update(url.rev);
    },
    setComment: (update: (current: string | null) => string | null) => {
      url.comment = update(url.comment);
    },
    onOpened: (root: string, branch: string | null) => {
      opened.push([root, branch]);
    },
    onGone: (path: string) => {
      gone.push(path);
    },
  };
  const hook = await renderHook(useSession, props);
  await settle();
  const sessionCalls = () =>
    calls.filter((c) => c.url.pathname === "/api/session");
  return { ...hook, props, calls, sessionCalls, url, opened, gone };
}

beforeEach(installEventSource);

test("opening a repo loads its session and settles the rev and the comment", async () => {
  const { result, sessionCalls, url } = await mount(
    () => ({ json: sessionFor("/repos/a", { threads: ["t1"] }) }),
    { ref: "feature/x", comment: "t1" },
  );
  const [call] = sessionCalls();
  assert.equal(call.url.searchParams.get("repo"), "/repos/a");
  assert.equal(call.url.searchParams.get("ref"), "feature/x");
  assert.equal(result.current.session?.repo.root, "/repos/a");
  assert.deepEqual(result.current.shown, {
    repo: "/repos/a",
    ref: "feature/x",
  });
  assert.equal(result.current.loading, false);
  assert.equal(url.rev, SHA);
  assert.equal(url.comment, "t1");
});

test("a comment the PR no longer has is let go", async () => {
  const { url } = await mount(() => ({ json: sessionFor("/repos/a") }), {
    comment: "gone",
  });
  assert.equal(url.comment, null);
});

test("a slower earlier answer is dropped", async () => {
  const held = new Map<string, () => void>();
  const { result, rerender, props } = await mount(
    (call) =>
      new Promise((resolve) => {
        const repo = call.url.searchParams.get("repo")!;
        held.set(repo, () => resolve({ json: sessionFor(repo) }));
      }),
  );
  await rerender({ ...props, repo: "/repos/b" });
  held.get("/repos/b")!();
  await settle();
  held.get("/repos/a")!();
  await settle();
  assert.equal(result.current.session?.repo.root, "/repos/b");
  assert.equal(result.current.shown.repo, "/repos/b");
});

test("an answer that arrives after going back to the inbox is dropped", async () => {
  let answer = () => {};
  const { result, rerender, props, calls, opened, url } = await mount(
    (call) =>
      new Promise((resolve) => {
        const repo = call.url.searchParams.get("repo")!;
        answer = () => resolve({ json: sessionFor(repo, { threads: ["t1"] }) });
      }),
    { comment: "t1" },
  );
  url.comment = null;
  await rerender({ ...props, repo: "" });
  answer();
  await settle();
  assert.equal(result.current.session, null);
  assert.equal(result.current.shown.repo, "");
  assert.equal(result.current.loading, false);
  assert.deepEqual(opened, []);
  assert.equal(url.comment, null);
  assert.equal(calls.filter((c) => c.url.pathname === "/api/looked").length, 0);
});

test("loading ends when the stream's catch-up overtakes the load that opened the repo", async () => {
  const held: Array<() => void> = [];
  const { result } = await mount(
    (call) =>
      new Promise((resolve) => {
        const repo = call.url.searchParams.get("repo")!;
        held.push(() => resolve({ json: sessionFor(repo) }));
      }),
  );
  assert.equal(result.current.loading, true);
  await FakeEventSource.opened[0].open();
  for (const answer of held) answer();
  await settle();
  assert.equal(result.current.loading, false);
  assert.equal(result.current.session?.repo.root, "/repos/a");
});

test("opening a branch marks it looked at once, with its tip; a background refresh doesn't", async () => {
  const { calls } = await mount(() => ({ json: sessionFor("/repos/a") }));
  const looked = () => calls.filter((c) => c.url.pathname === "/api/looked");
  assert.equal(looked().length, 1);
  assert.equal(looked()[0].method, "POST");
  assert.equal(looked()[0].url.searchParams.get("ref"), "main");
  assert.equal(looked()[0].url.searchParams.get("tip"), SHA);

  await FakeEventSource.opened[0].message(["worktree"]);
  await settle();
  assert.equal(looked().length, 1);
});

test("each watch event bumps its own tick and reloads only when something on disk moved", async () => {
  const { result, sessionCalls } = await mount(() => ({
    json: sessionFor("/repos/a"),
  }));
  const source = FakeEventSource.opened[0];
  assert.equal(source.url, "/api/watch?repo=%2Frepos%2Fa");
  const ticks = () => result.current.ticks;
  const loads = () => sessionCalls().length;

  await source.message(["review"]);
  assert.deepEqual(ticks(), { working: 0, review: 1, flows: 0, model: 0 });
  await source.message(["outbox"]);
  assert.deepEqual(ticks(), { working: 0, review: 2, flows: 0, model: 0 });
  await source.message(["flows"]);
  assert.deepEqual(ticks(), { working: 0, review: 2, flows: 1, model: 0 });
  assert.equal(loads(), 1);

  await source.message(["worktree"]);
  await settle();
  assert.deepEqual(ticks(), { working: 1, review: 2, flows: 1, model: 0 });
  assert.equal(loads(), 2);
  assert.equal(sessionCalls()[1].url.searchParams.get("fresh"), null);

  await source.message(["remote"]);
  await settle();
  assert.equal(loads(), 3);
  assert.equal(sessionCalls()[2].url.searchParams.get("fresh"), "1");

  await source.open();
  await settle();
  assert.deepEqual(ticks(), { working: 3, review: 3, flows: 1, model: 0 });
  assert.equal(loads(), 4);
  assert.equal(sessionCalls()[3].url.searchParams.get("fresh"), "1");
});

test("a foreground failure on a missing path shows the error and lets the page drop the recent", async () => {
  const { result, gone } = await mount(() => ({
    status: 400,
    json: { error: "No such folder", kind: "missing-path" },
  }));
  assert.equal(result.current.session, null);
  assert.equal(result.current.error, "No such folder");
  assert.deepEqual(gone, ["/repos/a"]);
});

test("a background failure keeps the last session and shows no error", async () => {
  let fail = false;
  const { result, gone } = await mount(() =>
    fail
      ? { status: 500, json: { error: "locked", kind: "git" } }
      : { json: sessionFor("/repos/a") },
  );
  fail = true;
  await FakeEventSource.opened[0].message(["worktree"]);
  await settle();
  assert.equal(result.current.session?.repo.root, "/repos/a");
  assert.equal(result.current.error, null);
  assert.deepEqual(gone, []);
});

test("a pinned sha survives a refresh; reopen starts from uncommitted work and forgets it", async () => {
  const { result, url } = await mount(() => ({
    json: sessionFor("/repos/a", { hasChanges: true }),
  }));
  const source = FakeEventSource.opened[0];
  assert.equal(url.rev, "working");

  url.rev = PASTED;
  await act(async () => result.current.pin(PASTED));
  await source.message(["worktree"]);
  await settle();
  assert.equal(url.rev, PASTED);
  assert.equal(result.current.revNotice, null);

  await act(async () => result.current.reopen());
  await source.message(["worktree"]);
  await settle();
  assert.equal(url.rev, "working");

  url.rev = PASTED;
  await source.message(["worktree"]);
  await settle();
  assert.equal(url.rev, "working");
  assert.equal(result.current.revNotice, PASTED);
});

test("onOpened hears of a root and branch once, not again on a refresh", async () => {
  let branch = "main";
  const { opened } = await mount(() => ({
    json: sessionFor("/repos/a", { branch }),
  }));
  const source = FakeEventSource.opened[0];
  await source.message(["worktree"]);
  await settle();
  assert.deepEqual(opened, [["/repos/a", "main"]]);

  branch = "feature/x";
  await source.message(["head"]);
  await settle();
  assert.deepEqual(opened, [
    ["/repos/a", "main"],
    ["/repos/a", "feature/x"],
  ]);
});

test("focus on the same build reloads in the background and bumps working, review and model", async () => {
  const { result, sessionCalls } = await mount(() => ({
    json: sessionFor("/repos/a"),
  }));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
  assert.deepEqual(result.current.ticks, {
    working: 1,
    review: 1,
    flows: 0,
    model: 1,
  });
  assert.equal(sessionCalls().length, 2);
  assert.equal(result.current.loading, false);
});

test("the stream is opened once and closed on unmount", async () => {
  const { rerender, props, unmount } = await mount(() => ({
    json: sessionFor("/repos/a"),
  }));
  await rerender({ ...props, onOpened: () => {}, onGone: () => {} });
  assert.equal(FakeEventSource.opened.length, 1);
  await unmount();
  assert.equal(FakeEventSource.opened[0].closed, true);
});
