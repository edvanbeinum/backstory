import { watch, type FSWatcher } from "node:fs";
import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { gitLine } from "@/lib/exec";
import { resolveRepo } from "@/lib/git";
import { onFlowsChange } from "@/lib/flows/store";
import { onReviewChange } from "@/lib/review";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of "the repo changed" notifications.
 *
 * The window opens one EventSource per repo; the server watches the
 * filesystem and pushes a debounced event whenever git state or the working
 * tree moves. Three watch points, because they live in different places:
 *
 * - the worktree root — edits to tracked/untracked files
 * - the git dir — HEAD, index: commits, stages, branch switches. For a
 *   linked worktree this is NOT under the root (`.git` is a file pointing
 *   elsewhere), which is why it's resolved via rev-parse and watched
 *   separately.
 * - the common dir — refs, including refs/remotes: pushes and fetches. In a
 *   worktree this is the main checkout's .git.
 *
 * Events carry a coarse kind so the client can decide how hard to refresh:
 * "remote" (refs/remotes moved — bypass the GitHub cache), "git" (local git
 * state), "worktree" (file edits), and "review" — not the filesystem at all,
 * but an agent starting or stopping waiting for your notes on this checkout.
 * "flows" is the other non-filesystem kind: a flow run finished.
 */

const DEBOUNCE_MS = 400;
const HEARTBEAT_MS = 20_000;

/** Working-tree noise that would otherwise cause refetch storms. */
const WORKTREE_IGNORE =
  /(^|\/)(node_modules|\.next|dist|build|\.DS_Store|\.venv|target|DerivedData)(\/|$)/;

/** Git-dir noise: object writes, lockfile churn, transient fetch state. */
const GITDIR_IGNORE = /(^|\/)(objects|lfs)\/|\.lock$|^gc\.pid$|^FETCH_HEAD$/;

function classifyGitPath(rel: string): "remote" | "git" | null {
  if (GITDIR_IGNORE.test(rel)) return null;
  if (rel.startsWith("refs/remotes/") || rel === "packed-refs") return "remote";
  return "git";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "`repo` is required.", kind: "missing-path" },
      { status: 400 },
    );
  }

  let root: string;
  let gitDir: string;
  let commonDir: string;
  try {
    const repo = await resolveRepo(repoPath);
    root = repo.root;
    gitDir =
      (await gitLine(root, ["rev-parse", "--absolute-git-dir"])) ??
      `${root}/.git`;
    commonDir =
      (await gitLine(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])) ?? gitDir;
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const watchers: FSWatcher[] = [];
      let pending = new Set<string>();
      let debounce: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      const send = (payload: object) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // stream already torn down — cleanup follows via abort
        }
      };

      const queue = (kind: string) => {
        pending.add(kind);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const kinds = [...pending];
          pending = new Set();
          send({ kinds });
        }, DEBOUNCE_MS);
      };

      const tryWatch = (
        dir: string,
        recursive: boolean,
        handler: (rel: string) => void,
      ) => {
        try {
          const watcher = watch(dir, { recursive }, (_event, filename) => {
            handler(typeof filename === "string" ? filename : "");
          });
          // A watcher error (dir deleted, FSEvents hiccup) must not crash the
          // process; degrade to heartbeat-only and let the client's next
          // reconnect re-establish it.
          watcher.on("error", () => {});
          watchers.push(watcher);
        } catch {
          // recursive watch unavailable — the other watch points still work
        }
      };

      // Working tree. The git dir may be inside it (normal checkout), so
      // route .git/… paths through the git classifier instead of dropping
      // them wholesale.
      tryWatch(root, true, (rel) => {
        if (rel.startsWith(".git/") || rel === ".git") {
          const kind = classifyGitPath(rel.replace(/^\.git\//, ""));
          if (kind) queue(kind);
          return;
        }
        if (WORKTREE_IGNORE.test(rel)) return;
        queue("worktree");
      });

      // Git dir (worktree-private state: HEAD, index) — only needed as its
      // own watch point when it lives outside the root.
      if (!gitDir.startsWith(`${root}/`)) {
        tryWatch(gitDir, false, (rel) => {
          const kind = classifyGitPath(rel);
          if (kind) queue(kind);
        });
      }

      // Common dir (shared refs). Distinct from gitDir for linked worktrees;
      // also covers refs/remotes updates from pushes made in other terminals.
      if (commonDir !== gitDir && !commonDir.startsWith(`${root}/`)) {
        tryWatch(commonDir, true, (rel) => {
          const kind = classifyGitPath(rel);
          if (kind) queue(kind);
        });
      }

      // Sent straight away, not debounced: nothing floods this, and the
      // window should offer "Send to agent" the moment an agent asks.
      const stopReviews = onReviewChange((changedRoot) => {
        if (changedRoot === root) send({ kinds: ["review"] });
      });
      const stopFlows = onFlowsChange((changedRoot) => {
        if (changedRoot === root) send({ kinds: ["flows"] });
      });

      // Keep intermediaries from reaping the idle connection.
      const heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            // torn down
          }
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        closed = true;
        stopReviews();
        stopFlows();
        clearInterval(heartbeat);
        if (debounce) clearTimeout(debounce);
        for (const w of watchers) w.close();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", cleanup);
      send({ hello: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
