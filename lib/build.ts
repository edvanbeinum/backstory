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
    return readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

export const BUILD_ID = readBuildId();
