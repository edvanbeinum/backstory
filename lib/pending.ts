/**
 * The handoff slot between the `differ` CLI and the installed app window.
 *
 * The CLI can't deep-link into a PWA window — launching one always lands on
 * its start_url — so instead the CLI parks the repo path here and the window
 * picks it up: once on load, and again every time it regains focus (i.e. the
 * Cmd-Tab moment). In-memory is correct — the value is only meaningful while
 * this server process is alive, and it should die with it.
 */
let pendingRepo: string | null = null;
let pendingAt = 0;

/** Ignore stale handoffs: a repo parked hours ago shouldn't hijack focus. */
const PENDING_TTL_MS = 5 * 60 * 1000;

export function setPendingRepo(repo: string) {
  pendingRepo = repo;
  pendingAt = Date.now();
}

export function takePendingRepo(): string | null {
  if (!pendingRepo) return null;
  const value = Date.now() - pendingAt <= PENDING_TTL_MS ? pendingRepo : null;
  pendingRepo = null;
  return value;
}
