import type { SessionResponse } from "./types";

/**
 * Whether a commit on this branch has been pushed, or null when Backstory can't
 * say.
 *
 * `commits` and `history` split the branch at the push boundary, but the
 * boundary only means "pushed" when there's somewhere to push to. With no
 * remote refs it's a local branch, and nothing has left the machine. And a
 * branch reviewed without checking it out lists `base..ref`, which says
 * nothing about remotes either way.
 */
export function pushedState(
  session: SessionResponse,
  sha: string,
): boolean | null {
  if (!session.hasRemote) return false;
  if (session.repo.ref) return null;
  if (session.commits.some((c) => c.sha === sha)) return false;
  if (session.history.some((c) => c.sha === sha)) return true;
  return null;
}
