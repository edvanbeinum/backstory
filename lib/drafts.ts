import type { SessionResponse } from "./types";

/**
 * Drafts that have been typed but not yet acknowledged by the store.
 *
 * A reply is the one thing in differ you can't reconstruct — a tick is one
 * click to redo and a link is one pick, but nobody can retype what they wrote
 * from memory. So the window, not the disk, is the first place a draft lands,
 * and it stays here until a write comes back successful.
 */

/** A draft typed here, with the pull request it was typed on. */
export interface PendingDraft {
  /**
   * `owner/repo#42`. Carried rather than looked up when the write finally
   * lands: a retry that outlives the view it started in would otherwise file
   * your reply under whatever pull request is open by then.
   */
  key: string;
  text: string | null;
  /**
   * The store said yes, but no read has come back holding this text yet.
   *
   * A session fetch issued before you typed can land after the write did, and
   * it carries the old text. Keeping the draft here until a load agrees with
   * it is what stops that stale answer painting an empty box.
   */
  saved?: boolean;
}

/**
 * `owner/repo#42` — the response store's key, read off the session rather than
 * asked of the server. Deriving it server-side used to cost a repo resolve and
 * a GitHub lookup on every write, and meant drafts were dropped whenever
 * GitHub was unreachable.
 */
export function keyFor(session: SessionResponse | null): string | null {
  const repo = session?.repo;
  const pr = session?.github.pr;
  if (!repo?.owner || !repo.name || !pr) return null;
  return `${repo.owner}/${repo.name}#${pr.number}`;
}

/**
 * Threads whose draft the freshly loaded session already agrees with — the
 * point at which the window can stop holding a copy.
 *
 * Only written drafts qualify: one still waiting on its write is exactly the
 * thing the incoming data doesn't know about yet.
 */
export function confirmedDrafts(
  session: SessionResponse,
  drafts: Map<string, PendingDraft>,
  key: string | null,
): string[] {
  if (drafts.size === 0) return [];
  return session.github.threads
    .filter((thread) => {
      const pending = drafts.get(thread.id);
      return (
        pending?.saved === true &&
        pending.key === key &&
        thread.response.reply === pending.text
      );
    })
    .map((thread) => thread.id);
}

/**
 * Overlay unacknowledged drafts onto a freshly loaded session.
 *
 * A background refresh — the watcher, a focus, a reconnect — carries whatever
 * was on disk when it was asked for, which for a reply typed a moment ago is
 * nothing. Applied blind, it echoes an empty box back over what you wrote.
 *
 * Drafts for another pull request are left where they are: same window, but
 * they belong to a view that isn't on screen.
 */
export function withDrafts(
  session: SessionResponse,
  drafts: Map<string, PendingDraft>,
  key: string | null,
): SessionResponse {
  if (drafts.size === 0) return session;
  return {
    ...session,
    github: {
      ...session.github,
      threads: session.github.threads.map((thread) => {
        const pending = drafts.get(thread.id);
        if (!pending || pending.key !== key) return thread;
        return {
          ...thread,
          response: { ...thread.response, reply: pending.text },
        };
      }),
    },
  };
}
