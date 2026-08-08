import type { ResponseRecord } from "./responses";

export interface Progress {
  done: number;
  total: number;
  /** GitHub had more items than one page returned, so `total` is a floor. */
  truncated: boolean;
}

/**
 * How far through a PR's comments you are.
 *
 * Lives on its own because two screens show it — the inbox row and the
 * workspace header — and a checklist whose two counts disagree is worse than
 * one that doesn't count at all.
 *
 * An item is anything that needs a response: every review thread, plus every
 * review left as a top-level body with prose in it. A review with an empty
 * body is just the envelope around inline comments and isn't an item.
 *
 * `done` intersects against the live ids on purpose. A thread you ticked and
 * GitHub later deleted would otherwise keep counting, and the tally could
 * climb past its own total.
 */
export function countProgress(
  liveIds: Iterable<string>,
  responses: Record<string, ResponseRecord>,
  opts: { reportedTotal?: number } = {},
): Progress {
  const ids = [...liveIds];
  let done = 0;
  for (const id of ids) {
    if (responses[id]?.done) done += 1;
  }

  const reported = opts.reportedTotal ?? ids.length;
  return {
    done,
    total: Math.max(ids.length, reported),
    truncated: reported > ids.length,
  };
}
