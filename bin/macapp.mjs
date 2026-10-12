/**
 * The Mac app (`mac/`) as the CLI sees it: where it's installed, the
 * `backstory://` link that opens a repo in it, and where `backstory` opens a
 * repo.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_PORT } from "./hook.mjs";

export const BUNDLE_ID = "dev.backstory.app";

export const NOT_INSTALLED =
  "Backstory's Mac app isn't installed. Download it from " +
  "https://github.com/edvanbeinum/backstory/releases/latest, or build it " +
  "with `npm run mac:build` and drag `mac/build/Backstory.app` to " +
  "Applications.";

/** Where to look for the Mac app, in order. BACKSTORY_APP names one explicitly. */
export function macAppCandidates(env = process.env) {
  return [
    env.BACKSTORY_APP,
    "/Applications/Backstory.app",
    path.join(homedir(), "Applications", "Backstory.app"),
  ].filter(Boolean);
}

/**
 * The first candidate that is Backstory's Mac app, or null. Checks the bundle
 * id because Safari's "Add to Dock" window also lands at
 * `~/Applications/Backstory.app`. Reads the plist as bytes rather than parsing
 * it, since Xcode may write it in binary form.
 */
export function findMacApp(candidates = macAppCandidates()) {
  return (
    candidates.find((app) => {
      try {
        return readFileSync(
          path.join(app, "Contents", "Info.plist"),
          "latin1",
        ).includes(BUNDLE_ID);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Encodes the path whole, so `&`, `#` and `+` in it survive the link. */
export function repoLink(root) {
  return `backstory://open?repo=${encodeURIComponent(root)}`;
}

/**
 * Where `backstory` opens `repo`: the arguments for `open`, or an error to
 * print.
 *
 * On the default port the Mac app owns the server, so the repo goes to the app
 * by path, which launches it when it isn't running and reaches this copy
 * whichever copy LaunchServices thinks owns `backstory://`. On any other port
 * a Backstory that answers is a dev server, shown in the browser.
 *
 * @param {{ repo: string, port: number, app: string | null, running: boolean }} options
 * @returns {{ open: string[] } | { error: string }}
 */
export function launchPlan({ repo, port, app, running }) {
  if (port === DEFAULT_PORT && app) {
    return { open: ["-a", app, repoLink(repo)] };
  }
  if (running) {
    return {
      open: [`http://127.0.0.1:${port}/?repo=${encodeURIComponent(repo)}`],
    };
  }
  if (port !== DEFAULT_PORT) {
    return { error: `nothing is answering on :${port}.` };
  }
  return { error: NOT_INSTALLED };
}
