import { Window } from "happy-dom";

/**
 * Installs a happy-dom window's globals by hand, because its
 * `global-registrator` export is ESM-only and the tests run as CommonJS. A
 * file of its own so they're in place before React DOM loads. Node's test
 * runner gives each file its own process, so they never reach another test
 * file.
 */
const dom = new Window({ url: "http://127.0.0.1:3000/" });
const globals = [
  "window",
  "document",
  "localStorage",
  "history",
  "location",
  "navigator",
  "HTMLElement",
  "Node",
  "Event",
  "CustomEvent",
  "PopStateEvent",
  "KeyboardEvent",
  "FocusEvent",
  "MessageEvent",
] as const;
for (const name of globals) {
  Object.defineProperty(globalThis, name, {
    value: dom[name],
    configurable: true,
    writable: true,
  });
}
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
