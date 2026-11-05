"use client";

import { useEffect, useState } from "react";

import type { OpenView } from "@/components/ViewContext";
import { BRANCH_REV, WORKING_REV } from "@/lib/constants";
import type { DataResponse } from "@/lib/data/types";
import type { MapResponse } from "@/lib/map";
import type { ApiError, DiffResponse, SessionResponse } from "@/lib/types";
import { viewKey, viewParams } from "@/lib/url";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    const err = data as ApiError;
    throw new Error(err.detail ? `${err.error} (${err.detail})` : err.error);
  }
  return data as T;
}

/**
 * A view's data: its diff, its map and its data model, each kept with the
 * view it was read for, so a switch keeps the last view on screen until this
 * one's answers arrive and never pairs one view's diff with another's map.
 */
export function useViewData({
  repo,
  ready,
  shown,
  rev,
  session,
  ticks,
}: {
  /** The repo in the address bar, whose trunk reads start as it opens */
  repo: string;
  ready: boolean;
  /** The repo and branch the session was loaded for */
  shown: OpenView;
  rev: string;
  session: SessionResponse | null;
  ticks: { working: number; model: number };
}) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  /** The view the diff on screen was read for: its `rev` alone doesn't name the branch. */
  const [diffView, setDiffView] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [mapRead, setMapRead] = useState<{
    view: string;
    map: MapResponse;
  } | null>(null);
  /**
   * Shows no data model while another view's read is on the way, so the
   * story never offers a paid Read again for one view beside the data model
   * of another.
   */
  const [dataRead, setDataRead] = useState<{
    view: string;
    data: DataResponse;
  } | null>(null);

  const viewId = viewKey({ ...shown, rev });
  const haveSession = session !== null;
  // A commit's diff is immutable, so watcher ticks only matter for the two
  // views that move — uncommitted work, and the branch diff (its tip end
  // advances with every commit); pinning the key otherwise keeps background
  // session refreshes from refetching a diff that cannot have changed. A
  // branch opened by ref keys on its base and tip instead: saves in the
  // checkout fire watcher ticks, but can't move another branch.
  const branchEnds = shown.ref
    ? `${session?.base.sha}..${session?.commits[0]?.sha}`
    : ticks.working;
  const workingDiffKey =
    rev === WORKING_REV || rev === BRANCH_REV ? branchEnds : -1;

  // Start reading main's data model and map as a repo opens, while a pull
  // request is still being chosen. The server starts each unless the repo is
  // turned off or main has a model of that kind already.
  useEffect(() => {
    if (!ready || !repo) return;
    const trunk = `repo=${encodeURIComponent(repo)}&trunk=1`;
    for (const api of ["data", "map"])
      void fetch(`/api/${api}?${trunk}`, { method: "POST" }).catch(() => {});
  }, [ready, repo]);

  useEffect(() => {
    if (!shown.repo || !haveSession) return;

    let cancelled = false;
    // Watcher-driven refetches of the working diff keep the old content on
    // screen until the new one arrives; only a rev switch shows the loader.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows the loader, then fetches the new rev
    setDiffLoading(true);
    setDiffError(null);

    getJson<DiffResponse>(
      `/api/diff?${viewParams({ repo: shown.repo, ref: shown.ref, rev })}`,
    )
      .then((data) => {
        if (cancelled) return;
        setDiff(data);
        setDiffView(viewId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shown, rev, viewId, haveSession, workingDiffKey]);

  // The map follows the diff: a commit's never changes; the branch's moves
  // with its tip, and uncommitted work's with each save. The data model reads
  // files at a commit, so uncommitted work has none.
  useEffect(() => {
    if (!shown.repo || !haveSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the map where there is none, else fetches it
      setMapRead(null);
      setDataRead(null);
      return;
    }
    let cancelled = false;
    const query = viewParams({ repo: shown.repo, ref: shown.ref, rev });
    getJson<MapResponse>(`/api/map?${query}`)
      .then((data) => !cancelled && setMapRead({ view: viewId, map: data }))
      .catch(() => !cancelled && setMapRead(null));
    if (rev === WORKING_REV) setDataRead(null);
    else
      getJson<DataResponse>(`/api/data?${query}`)
        .then((data) => !cancelled && setDataRead({ view: viewId, data }))
        .catch(() => !cancelled && setDataRead(null));
    return () => {
      cancelled = true;
    };
  }, [shown, rev, viewId, haveSession, workingDiffKey, ticks.model]);

  return {
    viewId,
    workingDiffKey,
    diff,
    diffLoading,
    diffError,
    // The last view's diff stays on screen while this one's loads; this
    // view's flows must wait for it, or they're matched against the old
    // diff's files.
    diffIsCurrent: diff !== null && diffView === viewId,
    map: mapRead?.view === viewId ? mapRead.map : null,
    data: dataRead?.view === viewId ? dataRead.data : null,
  };
}
