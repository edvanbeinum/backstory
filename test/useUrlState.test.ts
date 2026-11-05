import { act, renderHook } from "./render";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { useUrlState } from "../components/useUrlState";
import { STORAGE_KEY } from "../lib/constants";

const SHA = "acd23a2dded210809c71c59833d2a986d7946e26";

function goTo(url: string) {
  history.replaceState(null, "", url);
}

function address() {
  return `${location.pathname}${location.search}`;
}

beforeEach(() => {
  localStorage.clear();
  goTo("/");
});

test("a URL naming a view opens that view after mount, and ready turns true", async () => {
  goTo(`/?repo=/repos/a&ref=feature/x&rev=${SHA}&tab=files`);
  const { result } = await renderHook(useUrlState, undefined);
  const url = result.current;
  assert.equal(url.ready, true);
  assert.equal(url.repo, "/repos/a");
  assert.equal(url.ref, "feature/x");
  assert.equal(url.rev, SHA);
  assert.equal(url.tab, "files");
  assert.equal(localStorage.getItem(STORAGE_KEY), "/repos/a");
});

test("a ?comment= link opens Comments", async () => {
  goTo("/?repo=/repos/a&comment=t1");
  const { result } = await renderHook(useUrlState, undefined);
  assert.equal(result.current.comment, "t1");
  assert.equal(result.current.tab, "comments");
});

test("a rev replaces the URL; opening from the inbox and going back each push", async () => {
  const { result } = await renderHook(useUrlState, undefined);
  const start = history.length;

  await act(async () => result.current.open("/repos/a", null));
  assert.equal(address(), "/?repo=/repos/a");
  assert.equal(history.length, start + 1);

  await act(async () => result.current.setRev(SHA));
  assert.equal(address(), `/?repo=/repos/a&rev=${SHA}`);
  assert.equal(history.length, start + 1);

  await act(async () => result.current.toInbox());
  assert.equal(address(), "/");
  assert.equal(history.length, start + 2);
  assert.equal(result.current.rev, "working");
  assert.equal(result.current.tab, "story");
});

test("popstate to an earlier URL restores the view it names", async () => {
  goTo(`/?repo=/repos/a&rev=${SHA}&comment=t1&tab=files`);
  const { result } = await renderHook(useUrlState, undefined);
  await act(async () => result.current.toInbox());
  assert.equal(result.current.repo, "");

  goTo(`/?repo=/repos/b&ref=feature/y&rev=${SHA}&comment=t2&tab=files`);
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const url = result.current;
  assert.equal(url.repo, "/repos/b");
  assert.equal(url.ref, "feature/y");
  assert.equal(url.rev, SHA);
  assert.equal(url.comment, "t2");
  assert.equal(url.tab, "files");
});
