import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import {
  getBoundarySha,
  getBranchDiffSummary,
  getCommits,
  getHistory,
  getPatchId,
  getPatchIdMap,
  getWorkingTree,
  isOnBranch,
  resolveBase,
  resolveRepo,
} from "@/lib/git";
import { getDrafts } from "@/lib/drafts";
import { loadGitHubDataCached } from "@/lib/github";
import {
  getLinks,
  prKey,
  updateLinks,
  type LinkRecord,
} from "@/lib/links";
import type { ApiError, SessionResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  // fresh=1 bypasses the GitHub cache: the manual refresh button, and
  // watcher events that saw refs/remotes move (a push landed).
  const fresh = searchParams.get("fresh") === "1";

  if (!repoPath) {
    return NextResponse.json<ApiError>(
      { error: "Choose a repository to review.", kind: "missing-path" },
      { status: 400 },
    );
  }

  try {
    const repo = await resolveRepo(repoPath);
    const rawBase = await resolveBase(repo);

    // Commits first: the boundary (and so the history walk) is defined by
    // the oldest unpushed commit, not by the raw merge base — after a rebase
    // those differ, and the boundary is the honest one.
    const commits = await getCommits(repo, rawBase);
    const boundarySha = await getBoundarySha(repo.root, commits, rawBase);
    const base = {
      ...rawBase,
      boundarySha,
      // When the boundary has moved off the merge base, "ahead of
      // <upstream>" would overstate the count — say what the list now means.
      label:
        boundarySha && rawBase.sha && boundarySha !== rawBase.sha
          ? "not yet on any remote"
          : rawBase.label,
    };

    // GitHub is the slow part and the only one that can fail softly, so let
    // it run alongside the remaining local git work.
    const [history, working, rawGithub] = await Promise.all([
      getHistory(repo, base),
      getWorkingTree(repo),
      loadGitHubDataCached(repo, { fresh }),
    ]);

    // The branch diff needs the PR's base branch, so it waits on GitHub —
    // a couple of local git commands once that resolves. On a stacked PR
    // the base is the parent branch, not the default branch.
    const branchDiff = await getBranchDiffSummary(
      repo,
      base,
      rawGithub.pr?.baseRefName ?? null,
    );

    // Attach how each comment was handled. Nothing is inferred: differ used
    // to guess which commit answered a comment, but a guess always found
    // something, so no comment ever read as outstanding and the list
    // couldn't work as a checklist.
    const github = { ...rawGithub, threads: rawGithub.threads };
    if (rawGithub.threads.length > 0) {
      const key = rawGithub.pr
        ? prKey(repo.owner, repo.name, rawGithub.pr.number)
        : null;
      const [links, drafts] = key
        ? await Promise.all([getLinks(key), getDrafts(key)])
        : [{}, {}];

      /** Commit links only — acknowledgements have no sha to check. */
      const commitLinks = Object.entries(links).filter(
        (entry): entry is [string, Extract<LinkRecord, { kind: "commit" }>] =>
          entry[1].kind === "commit",
      );

      // A rebase rewrites shas, so a link can outlive its commit. Ask whether
      // each sha is still *reachable from HEAD* — not merely whether the
      // object exists, since rebased-away commits linger in the object
      // database and would otherwise pass as healthy.
      const alive = new Map<string, boolean>();
      for (const [, link] of commitLinks) {
        if (alive.has(link.sha)) continue;
        alive.set(link.sha, await isOnBranch(repo.root, link.sha));
      }

      // Links made before patch-ids existed have none stored, which would
      // leave them unable to survive the next rebase. Backfill quietly while
      // the commit is still reachable. Collected then written in a single
      // batch: separate writes would race each other through the same file.
      if (key) {
        const backfill: Record<string, LinkRecord> = {};
        for (const [threadId, link] of commitLinks) {
          if (link.patchId || !alive.get(link.sha)) continue;
          const patchId = await getPatchId(repo.root, link.sha);
          if (patchId) {
            links[threadId] = { kind: "commit", sha: link.sha, patchId };
            backfill[threadId] = links[threadId];
          }
        }
        await updateLinks(key, backfill);
      }

      // Anything still missing may just have been rebased. A commit's
      // patch-id hashes its diff alone, so a rewritten commit keeps it —
      // find the new sha rather than making the user re-link. Only computed
      // when something is actually broken.
      const healed = new Set<string>();
      const stale = commitLinks.filter(
        ([threadId, link]) =>
          !alive.get(link.sha) &&
          (links[threadId] as Extract<LinkRecord, { kind: "commit" }>).patchId,
      );
      if (stale.length > 0 && branchDiff && key) {
        const patchIds = await getPatchIdMap(
          repo.root,
          `${branchDiff.baseSha}..HEAD`,
        );
        const moves: Record<string, LinkRecord> = {};
        for (const [threadId] of stale) {
          const link = links[threadId];
          if (link.kind !== "commit" || !link.patchId) continue;
          // null = the patch-id appears more than once on the branch, so the
          // match is ambiguous; leave it broken and let the user decide.
          const match = patchIds.get(link.patchId);
          if (match) {
            links[threadId] = {
              kind: "commit",
              sha: match,
              patchId: link.patchId,
            };
            moves[threadId] = links[threadId];
            alive.set(match, true);
            healed.add(threadId);
          }
        }
        await updateLinks(key, moves);
      }

      github.threads = rawGithub.threads.map((thread) => {
        const link = links[thread.id];
        const linkedSha = link?.kind === "commit" ? link.sha : null;

        return {
          ...thread,
          linkedSha,
          linkedShaMissing: linkedSha ? !alive.get(linkedSha) : false,
          linkedShaHealed: healed.has(thread.id),
          acknowledged: link?.kind === "ack",
          draft: drafts[thread.id] ?? null,
        };
      });
    }

    const body: SessionResponse = {
      repo,
      base,
      commits,
      history,
      working,
      github,
      branchDiff,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
