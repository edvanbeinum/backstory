import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
 * A stand-in `security` keeping one token in a `keychain` file beside it,
 * and logging every argv to `security.log`. It reads with
 * `find-generic-password`, deletes with `delete-generic-password` (44 when
 * there's nothing to delete, as the real one does) and saves the `-w` of an
 * `add-generic-password` sent on stdin to `security -i`.
 */
export const SECURITY = `PATH=/usr/bin:/bin
dir="\${0%/*}"
echo "$*" >> "$dir/security.log"
case "$1" in
  find-generic-password) [ -f "$dir/keychain" ] || exit 44; cat "$dir/keychain" ;;
  delete-generic-password) [ -f "$dir/keychain" ] || exit 44; rm "$dir/keychain" ;;
  -i) read -r line; printf '%s' "\${line##* -w }" > "$dir/keychain" ;;
esac`;

export interface ApiCall {
  authorization: string | undefined;
  query: string;
  variables: Record<string, unknown>;
}

export interface ApiAnswer {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
}

/**
 * A local server standing in for GitHub's GraphQL API, for
 * `BACKSTORY_GITHUB_API`. Records each request and answers it with
 * `answer`, which sees the query and variables.
 */
export async function githubApiStandIn(
  answer: (call: ApiCall) => ApiAnswer,
): Promise<{ url: string; calls: ApiCall[]; close: () => Promise<void> }> {
  const calls: ApiCall[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const call: ApiCall = {
        authorization: request.headers.authorization,
        query: body.query ?? "",
        variables: body.variables ?? {},
      };
      calls.push(call);
      const reply = answer(call);
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        "x-oauth-scopes": "repo, read:org",
        ...reply.headers,
      });
      response.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // fetch keeps its socket alive, which would hold close() open
        server.closeAllConnections();
      }),
  };
}

/**
 * Points `$SHELL` at a shell that finds nothing, so a `gh` or `claude` call
 * never starts the user's login shell. Call before anything runs either.
 */
export function quietLoginShell() {
  process.env.SHELL = path.join(standIns({ sh: "exit 0" }), "sh");
}
