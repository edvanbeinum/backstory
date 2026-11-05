import { renderHook, settle, standInFetch, type FetchAnswer } from "./render";

import assert from "node:assert/strict";
import { test } from "node:test";

import { useViewData } from "../components/useViewData";
import type { SessionResponse } from "../lib/types";

const SHA = "c".repeat(40);

function sessionAt(tip: string): SessionResponse {
  return {
    base: { sha: "b".repeat(40) },
    commits: [{ sha: tip }],
  } as unknown as SessionResponse;
}

type Props = Parameters<typeof useViewData>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    repo: "/repos/a",
    ready: true,
    shown: { repo: "/repos/a", ref: null },
    rev: SHA,
    session: sessionAt(SHA),
    ticks: { working: 0, model: 0 },
    ...over,
  };
}

const ANSWERS = {
  "/api/diff": { json: { rev: SHA, files: [], additions: 0, deletions: 0 } },
  "/api/map": { json: { nodes: [] } },
  "/api/data": { json: { entities: [] } },
};

function reads(calls: ReturnType<typeof standInFetch>, path: string) {
  return calls.filter((c) => c.url.pathname === path && c.method === "GET");
}

test("a commit's diff isn't read again when the working tick moves; uncommitted work's is", async () => {
  const calls = standInFetch(ANSWERS);
  const shown = { repo: "/repos/a", ref: null };
  const { rerender } = await renderHook(useViewData, props({ shown }));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 1);

  await rerender(props({ shown, ticks: { working: 1, model: 0 } }));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 1);

  await rerender(props({ shown, rev: "working" }));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 2);
  await rerender(
    props({ shown, rev: "working", ticks: { working: 2, model: 0 } }),
  );
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 3);
});

test("a branch opened by ref is keyed on its base and tip, so a tick alone doesn't read it again", async () => {
  const calls = standInFetch(ANSWERS);
  const shown = { repo: "/repos/a", ref: "feature/x" };
  const at = (working: number, tip: string) =>
    props({
      shown,
      rev: "branch",
      session: sessionAt(tip),
      ticks: { working, model: 0 },
    });
  const { rerender } = await renderHook(useViewData, at(0, SHA));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 1);
  assert.equal(
    reads(calls, "/api/diff")[0].url.searchParams.get("ref"),
    "feature/x",
  );

  await rerender(at(1, SHA));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 1);

  await rerender(at(1, "d".repeat(40)));
  await settle();
  assert.equal(reads(calls, "/api/diff").length, 2);
});

test("the last view's answers count as no one's until this view's arrive", async () => {
  const held: Array<() => void> = [];
  const hold = (answer: FetchAnswer) => () =>
    new Promise<FetchAnswer>((resolve) => held.push(() => resolve(answer)));
  standInFetch({
    "/api/diff": hold(ANSWERS["/api/diff"]),
    "/api/map": hold(ANSWERS["/api/map"]),
    "/api/data": hold(ANSWERS["/api/data"]),
  });
  const shown = { repo: "/repos/a", ref: null };
  const { result, rerender } = await renderHook(useViewData, props({ shown }));
  for (const release of held.splice(0)) release();
  await settle();
  assert.equal(result.current.diffIsCurrent, true);
  assert.ok(result.current.map);
  assert.ok(result.current.data);

  const other = "e".repeat(40);
  await rerender(props({ shown, rev: other }));
  await settle();
  assert.ok(result.current.diff, "the last diff stays on screen");
  assert.equal(result.current.diffIsCurrent, false);
  assert.equal(result.current.diffLoading, true);
  assert.equal(result.current.map, null);
  assert.equal(result.current.data, null);

  for (const release of held.splice(0)) release();
  await settle();
  assert.equal(result.current.diffIsCurrent, true);
  assert.equal(result.current.diffLoading, false);
  assert.ok(result.current.map);
  assert.ok(result.current.data);
});

test("uncommitted work reads the map and not the data model; the model tick reads both again", async () => {
  const calls = standInFetch(ANSWERS);
  const shown = { repo: "/repos/a", ref: null };
  const { result, rerender } = await renderHook(
    useViewData,
    props({ shown, rev: "working" }),
  );
  await settle();
  assert.equal(reads(calls, "/api/map").length, 1);
  assert.equal(reads(calls, "/api/data").length, 0);
  assert.equal(result.current.data, null);

  await rerender(props({ shown }));
  await settle();
  assert.equal(reads(calls, "/api/map").length, 2);
  assert.equal(reads(calls, "/api/data").length, 1);

  await rerender(props({ shown, ticks: { working: 0, model: 1 } }));
  await settle();
  assert.equal(reads(calls, "/api/map").length, 3);
  assert.equal(reads(calls, "/api/data").length, 2);
  assert.equal(
    reads(calls, "/api/diff").length,
    2,
    "the diff isn't read again",
  );
});

test("the trunk reads are posted once as a repo opens", async () => {
  const calls = standInFetch(ANSWERS);
  const shown = { repo: "/repos/a", ref: null };
  const { rerender } = await renderHook(useViewData, props({ shown }));
  await rerender(props({ shown, rev: "working" }));
  await settle();
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(
    posts.map((c) => `${c.url.pathname}?${c.url.searchParams}`),
    [
      "/api/data?repo=%2Frepos%2Fa&trunk=1",
      "/api/map?repo=%2Frepos%2Fa&trunk=1",
    ],
  );
});
