import "./dom";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

export { act };

/** Lets pending promises, such as a stand-in fetch's answer, settle. */
export function settle(): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * Renders `hook` alone in a component that does nothing else. `result.current`
 * is what the latest render returned.
 */
export async function renderHook<P, R>(hook: (props: P) => R, props: P) {
  const result = { current: undefined as R };
  function Probe({ p }: { p: P }) {
    result.current = hook(p);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { p: props })));
  return {
    result,
    rerender: (next: P) =>
      act(async () => root.render(createElement(Probe, { p: next }))),
    unmount: () => act(async () => root.unmount()),
  };
}

export interface FetchCall {
  url: URL;
  method: string;
}

export interface FetchAnswer {
  status?: number;
  json?: unknown;
}

type Answerer =
  FetchAnswer | ((call: FetchCall) => FetchAnswer | Promise<FetchAnswer>);

/**
 * Replaces `fetch` with one that records each call and answers it from
 * `table`, by path. A path the table leaves out answers 404.
 */
export function standInFetch(table: Record<string, Answerer>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = {
      url: new URL(String(input), "http://127.0.0.1:3000"),
      method: init?.method ?? "GET",
    };
    calls.push(call);
    const entry = table[call.url.pathname];
    const answer =
      typeof entry === "function"
        ? await entry(call)
        : (entry ?? { status: 404, json: { error: "not found" } });
    return new Response(JSON.stringify(answer.json ?? {}), {
      status: answer.status ?? 200,
    });
  }) as typeof fetch;
  return calls;
}

/** An `EventSource` the test drives, recording every one opened. */
export class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    return act(async () => this.onopen?.());
  }

  message(kinds: string[]) {
    return act(async () =>
      this.onmessage?.({ data: JSON.stringify({ kinds }) }),
    );
  }
}

export function installEventSource() {
  FakeEventSource.opened = [];
  Object.defineProperty(globalThis, "EventSource", {
    value: FakeEventSource,
    configurable: true,
    writable: true,
  });
}
