import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A temp folder of `#!/bin/sh` scripts standing in for `gh`, `claude`, a
 * shell and the like, so no test runs the real ones. Returns the folder.
 */
export function standIns(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "backstory-standins-"));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  }
  return dir;
}

/**
 * Points `$SHELL` at a shell that finds nothing, so a `gh` or `claude` call
 * never starts the user's login shell. Call before anything runs either.
 */
export function quietLoginShell() {
  process.env.SHELL = path.join(standIns({ sh: "exit 0" }), "sh");
}
