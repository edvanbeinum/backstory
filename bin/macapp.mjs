/**
 * The Mac app (`mac/`) as the CLI sees it: where it's installed, and the
 * `differ://` link that opens a repo in it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BUNDLE_ID = "dev.differ.app";

/** Where to look for the Mac app, in order. DIFFER_APP names one explicitly. */
export function macAppCandidates(env = process.env) {
  return [
    env.DIFFER_APP,
    "/Applications/differ.app",
    path.join(homedir(), "Applications", "differ.app"),
  ].filter(Boolean);
}

/**
 * The first candidate that is differ's Mac app, or null. Checks the bundle id
 * because Safari's "Add to Dock" window also lands at
 * `~/Applications/differ.app`. Reads the plist as bytes rather than parsing
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

/** The link that opens `root` in the Mac app. */
export function repoLink(root) {
  return `differ://open?repo=${encodeURIComponent(root)}`;
}
