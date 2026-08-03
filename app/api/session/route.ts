import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { gitLine } from "@/lib/exec";
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
import { getLinks, prKey, updateLinks, type Pin } from "@/lib/links";
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

    // Tag each thread with (a) the user's pin, if any, and (b) the newest
    // branch commit touching its file — the reply composer's default for
    // "Addressed in <commit>". New objects, not mutation: the GitHub data
    // behind this is shared via a 30s cache.
    const github = { ...rawGithub, threads: rawGithub.threads };
    if (rawGithub.threads.length > 0) {
      const key = rawGithub.pr
        ? prKey(repo.owner, repo.name, rawGithub.pr.number)
        : null;
      const [pins, drafts] = key
        ? await Promise.all([getLinks(key), getDrafts(key)])
        : [{}, {}];

      // A rebase rewrites shas, so a pin can outlive its commit. Ask whether
      // each pinned sha is still *reachable from HEAD* — not merely whether
      // the object exists, since rebased-away commits linger in the object
      // database and would otherwise pass as healthy.
      const pinAlive = new Map<string, boolean>();
      for (const pin of Object.values(pins)) {
        if (pinAlive.has(pin.sha)) continue;
        pinAlive.set(pin.sha, await isOnBranch(repo.root, pin.sha));
      }

      // Pins made before patch-ids existed have none stored, which would
      // leave them unable to survive the next rebase. Backfill quietly while
      // their commit is still reachable — one cheap call per such pin, once.
      // Collected then written in a single batch: separate writes would race
      // each other through the same file.
      if (key) {
        const backfill: Record<string, Pin> = {};
        for (const [threadId, pin] of Object.entries(pins)) {
          if (pin.patchId || !pinAlive.get(pin.sha)) continue;
          const patchId = await getPatchId(repo.root, pin.sha);
          if (patchId) {
            pins[threadId] = { sha: pin.sha, patchId };
            backfill[threadId] = pins[threadId];
          }
        }
        await updateLinks(key, backfill);
      }

      // Anything still missing may just have been rebased. A commit's
      // patch-id hashes its diff alone, so a rewritten commit keeps it —
      // find the new sha by patch-id rather than making the user re-pin.
      // Only computed when something is actually broken.
      const healed = new Set<string>();
      const stale = Object.entries(pins).filter(
        ([, pin]) => !pinAlive.get(pin.sha) && pin.patchId,
      );
      if (stale.length > 0 && branchDiff && key) {
        const patchIds = await getPatchIdMap(
          repo.root,
          `${branchDiff.baseSha}..HEAD`,
        );
        const moves: Record<string, Pin> = {};
        for (const [threadId, pin] of stale) {
          // null = the patch-id appears more than once on the branch, so
          // the match is ambiguous; leave it broken and let the user decide.
          const match = pin.patchId ? patchIds.get(pin.patchId) : undefined;
          if (match) {
            pins[threadId] = { sha: match, patchId: pin.patchId };
            moves[threadId] = pins[threadId];
            pinAlive.set(match, true);
            healed.add(threadId);
          }
        }
        await updateLinks(key, moves);
      }

      // Cached per path, since threads cluster on few files.
      const byPath = new Map<string, string | null>();
      github.threads = await Promise.all(
        rawGithub.threads.map(async (thread) => {
          const pin = pins[thread.id];
          const pinnedSha = pin?.sha ?? null;
          const pinnedShaMissing = pinnedSha
            ? !pinAlive.get(pinnedSha)
            : false;

          let addressedBySha: string | null = null;
          if (branchDiff && thread.path) {
            let sha = byPath.get(thread.path);
            if (sha === undefined) {
              sha = await gitLine(repo.root, [
                "log",
                "-1",
                "--format=%H",
                `${branchDiff.baseSha}..HEAD`,
                "--",
                thread.path,
              ]);
              byPath.set(thread.path, sha);
            }
            addressedBySha = sha;
          }

          return {
            ...thread,
            addressedBySha,
            pinnedSha,
            pinnedShaMissing,
            pinnedShaHealed: healed.has(thread.id),
            draft: drafts[thread.id] ?? null,
          };
        }),
      );
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
