import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which build of differ this server is running, for the window to compare
 * against the build it was loaded from.
 *
 * `next build` writes the id to .next/BUILD_ID, and the standalone server runs
 * from its own directory, so it's found relative to the working directory in
 * both layouts. Read once: a running server's build can't change under it.
 */
function readBuildId(): string {
  if (process.env.NODE_ENV === "development") return "development";
  try {
    return readFileSync(
      path.join(process.cwd(), ".next", "BUILD_ID"),
      "utf8",
    ).trim();
  } catch {
    return "unknown";
  }
}

export const BUILD_ID = readBuildId();

/**
 * `package.json`'s version, the one the Mac app's About box shows too. Next
 * copies `package.json` into the standalone output, so like `BUILD_ID` it's
 * found from the working directory in a checkout and in the Mac app's bundle.
 */
export function readVersion(dir = process.cwd()): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
