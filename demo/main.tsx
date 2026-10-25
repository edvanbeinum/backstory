// The site's demo: Backstory's real page, answered from a recording of one
// change (demo/record.mjs) instead of a server. Notes are kept in memory;
// anything else that would change something says it can't in a demo.
import { createRoot } from "react-dom/client";

import Page from "@/app/page";
import type { Note } from "@/lib/types";

import { DEMO_REPO, IGNORED_PARAMS } from "./recording.mjs";

interface Recorded {
  method: string;
  path: string;
  params: Record<string, string>;
  status: number;
  body: unknown;
}

const keyOf = (method: string, path: string, params: URLSearchParams) =>
  `${method} ${path}?${new URLSearchParams(
    [...params].filter(([name]) => !IGNORED_PARAMS.includes(name)),
  )}`;

const realFetch = window.fetch.bind(window);
const recording = (await (
  await realFetch("recording.json")
).json()) as Recorded[];
const recorded = new Map(
  recording.map((r) => [
    keyOf(r.method, r.path, new URLSearchParams(r.params)),
    r,
  ]),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let notes: Note[] = [];

async function answer(url: URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/notes") {
    if (method === "POST") {
      const change = JSON.parse(String(init?.body)) as
        | { op: "save"; note: Note }
        | { op: "remove"; id: string }
        | { op: string };
      if (change.op === "save" && "note" in change) {
        const { note } = change;
        notes = notes.some((n) => n.id === note.id)
          ? notes.map((n) => (n.id === note.id ? note : n))
          : [...notes, note];
      } else if (change.op === "remove" && "id" in change) {
        notes = notes.filter((n) => n.id !== change.id);
      }
    }
    return json({ notes });
  }
  const hit = recorded.get(keyOf(method, url.pathname, url.searchParams));
  if (hit) return json(hit.body, hit.status);
  return json(
    {
      error: "This is a recorded demo, so Backstory can't do that here.",
      kind: "internal",
    },
    404,
  );
}

window.fetch = (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.href,
  );
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
    return answer(url, init);
  }
  return realFetch(input, init);
};

// Open the live-update stream and never send on it: a recording doesn't change.
class RecordedEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  constructor() {
    super();
    setTimeout(() => this.onopen?.(new Event("open")));
  }
  close() {
    this.readyState = 2;
  }
}
window.EventSource = RecordedEventSource as unknown as typeof EventSource;

if (!new URLSearchParams(location.search).has("repo")) {
  history.replaceState(
    null,
    "",
    `?${new URLSearchParams({ repo: DEMO_REPO })}`,
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
