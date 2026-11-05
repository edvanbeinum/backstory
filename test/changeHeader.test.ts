import { act, render, settle, standInFetch } from "./render";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";

import { ChangeHeader } from "../components/ChangeHeader";
import type { BranchDiffSummary, SessionResponse } from "../lib/types";

const diffVs = (label: string): BranchDiffSummary => ({
  baseSha: "b".repeat(40),
  label,
  commits: 3,
  filesChanged: 4,
  additions: 10,
  deletions: 2,
});

function sessionFor(
  over: {
    stackStart?: string | null;
    stackDiff?: BranchDiffSummary | null;
  } = {},
): SessionResponse {
  return {
    repo: { root: "/repos/app", branch: "stack-c", ref: "stack-c" },
    commits: [],
    history: [],
    working: { hasChanges: false, changedPaths: [] },
    github: { stackStart: over.stackStart ?? null },
    branchDiff: diffVs("vs stack-b"),
    stackDiff: over.stackDiff ?? null,
  } as unknown as SessionResponse;
}

async function mount(session: SessionResponse) {
  const picked: string[] = [];
  let fetched = 0;
  const props = (s: SessionResponse) => ({
    session: s,
    rev: "branch",
    onRevChange: (rev: string) => picked.push(rev),
    commit: null,
    diff: null,
    thread: null,
    pushed: false,
    onFetched: () => {
      fetched += 1;
    },
  });
  const view = await render(createElement(ChangeHeader, props(session)));
  const chip = (label: string) =>
    [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
  return {
    ...view,
    picked,
    fetched: () => fetched,
    chip,
    chips: () =>
      [...view.container.querySelectorAll("button")].map((b) => b.textContent),
    rerenderWith: (s: SessionResponse) =>
      view.rerender(createElement(ChangeHeader, props(s))),
  };
}

test("a stacked PR offers This PR and Whole stack, and any other offers All changes", async () => {
  const stacked = await mount(
    sessionFor({ stackStart: "epic", stackDiff: diffVs("vs epic") }),
  );
  assert.deepEqual(stacked.chips(), ["This PR", "Whole stack"]);
  assert.equal(
    stacked.chip("This PR")?.getAttribute("title"),
    "this pull request's changes vs stack-b",
  );
  assert.equal(
    stacked.chip("Whole stack")?.getAttribute("title"),
    "everything the stack brings vs epic",
  );
  await act(async () => stacked.chip("Whole stack")?.click());
  assert.deepEqual(stacked.picked, ["stack"]);

  const plain = await mount(sessionFor());
  assert.deepEqual(plain.chips(), ["All changes"]);
});

test("Whole stack fetches the branch the stack starts from when the clone hasn't got it, then opens on it", async () => {
  const calls = standInFetch({
    "/api/fetch": { json: { outcome: "unchanged", sha: "c".repeat(40) } },
  });
  const header = await mount(sessionFor({ stackStart: "epic" }));
  assert.equal(
    header.chip("Whole stack")?.getAttribute("title"),
    "fetches epic from origin, then shows everything the stack brings vs it",
  );

  await act(async () => header.chip("Whole stack")?.click());
  await settle();

  assert.deepEqual(
    calls.map((c) => [c.url.pathname, c.method, c.body]),
    [
      [
        "/api/fetch",
        "POST",
        { repo: "/repos/app", branch: "stack-c", base: "epic" },
      ],
    ],
  );
  assert.equal(header.fetched(), 1);
  assert.deepEqual(header.picked, []);

  await header.rerenderWith(
    sessionFor({ stackStart: "epic", stackDiff: diffVs("vs epic") }),
  );
  assert.deepEqual(header.picked, ["stack"]);
});

test("a fetch that fails shows git's message beside the chip and leaves the view as it was", async () => {
  standInFetch({
    "/api/fetch": {
      status: 500,
      json: { error: "Couldn't fetch `stack-c` from origin.", kind: "git" },
    },
  });
  const header = await mount(sessionFor({ stackStart: "epic" }));

  await act(async () => header.chip("Whole stack")?.click());
  await settle();

  assert.match(
    header.container.textContent ?? "",
    /Couldn't fetch `stack-c` from origin\./,
  );
  assert.equal(header.fetched(), 0);
  assert.deepEqual(header.picked, []);
  assert.ok(header.chip("Whole stack"));
});
