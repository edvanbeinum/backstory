"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MapResponse } from "@/lib/map";
import {
  isOnMap,
  startsByItself,
  type ChangeDescription as Description,
  type DescriptionResponse,
} from "@/lib/description/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { AlertIcon } from "./icons";
import { Elapsed } from "./SystemMap";
import { Badge, Button, Spinner } from "./ui";

/**
 * The view's description and its read, tagged with the view it answers for,
 * so a view the page has left never shows. Polls while a read runs rather
 * than adding a watch event: reads are rare.
 */
function useDescription(repo: string, rev: string, gitRef: string | null) {
  const view = `${repo}\n${rev}\n${gitRef ?? ""}`;
  const current = useRef(view);
  useEffect(() => {
    current.current = view;
  }, [view]);
  const [answer, setAnswer] = useState<{
    view: string;
    status: DescriptionResponse | null;
    error: string | null;
  } | null>(null);

  const request = useCallback(
    async (method: "GET" | "POST", redraft = false) => {
      const asked = `${repo}\n${rev}\n${gitRef ?? ""}`;
      const params = new URLSearchParams({ repo, rev });
      if (gitRef) params.set("ref", gitRef);
      if (redraft) params.set("redraft", "1");
      try {
        const response = await fetch(`/api/description?${params}`, {
          method,
          cache: "no-store",
        });
        const body = (await response.json()) as
          DescriptionResponse | { error?: string };
        // Drop an answer for a view the page has left, so it can't replace
        // the answer for the view on screen.
        if (current.current !== asked) return;
        if (!response.ok || !("status" in body))
          setAnswer((last) => ({
            view: asked,
            status: last?.view === asked ? last.status : null,
            error: ("error" in body ? body.error : null) ?? response.statusText,
          }));
        else setAnswer({ view: asked, status: body, error: null });
      } catch (err) {
        if (current.current !== asked) return;
        setAnswer((last) => ({
          view: asked,
          status: last?.view === asked ? last.status : null,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [repo, rev, gitRef],
  );

  useEffect(() => {
    void request("GET");
  }, [request]);

  const shown = answer?.view === view ? answer : null;
  const status = shown?.status ?? null;
  const running = status?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void request("GET"), 4000);
    return () => clearInterval(timer);
  }, [running, request]);

  // Starts once per view: a read that fails or can't run stays that way
  // until a click.
  const autoStart = startsByItself(status);
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStart || autoStarted.current === view) return;
    autoStarted.current = view;
    void request("POST");
  }, [autoStart, view, request]);

  return {
    status,
    error: shown?.error ?? null,
    start: (redraft = false) => void request("POST", redraft),
  };
}

const LABEL =
  "text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--fg-muted)]";

function Parts({
  description,
  map,
  onShowOnMap,
}: {
  description: Description;
  map: MapResponse | null;
  onShowOnMap: (name: string) => void;
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-[14px] leading-6 sm:grid-cols-[max-content_1fr]">
      <dt className={`${LABEL} sm:pt-0.5`}>What it does</dt>
      <dd className="m-0">{description.what}</dd>
      {description.why && (
        <>
          <dt className={`${LABEL} sm:pt-0.5`}>Why</dt>
          <dd className="m-0">{description.why}</dd>
        </>
      )}
      {description.lookFirst.length > 0 && (
        <>
          <dt className={`${LABEL} sm:pt-0.5`}>Where to look first</dt>
          <dd className="m-0">
            <ul className="m-0 list-none space-y-1 p-0">
              {description.lookFirst.map((l) => (
                <li key={l.name}>
                  {isOnMap(l.name, map) ? (
                    <button
                      type="button"
                      className="font-semibold text-[var(--accent)] hover:underline"
                      title={`Outline ${l.name} on the map`}
                      onClick={() => onShowOnMap(l.name)}
                    >
                      {l.name}
                    </button>
                  ) : (
                    <b className="font-semibold">{l.name}</b>
                  )}
                  {l.reason && <>: {l.reason}</>}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * What the change does, why, and where to look first, at the top of Story.
 * Read by the AI provider as the view opens when the repo reads
 * automatically, or on a click.
 */
export function ChangeDescription({
  repo,
  rev,
  gitRef,
  map,
  onShowOnMap,
}: {
  repo: string;
  rev: string;
  /** The branch the view is on, when it isn't the one checked out */
  gitRef: string | null;
  /** The map on screen, for which places to look first link to it */
  map: MapResponse | null;
  /** Outline a component on the map */
  onShowOnMap: (name: string) => void;
}) {
  const { status, error, start } = useDescription(repo, rev, gitRef);
  if (!status || status.status === "none") {
    return error ? (
      <p className="flex items-center gap-1 text-[12px] text-[var(--attention)]">
        <AlertIcon size={11} /> Couldn&apos;t describe this change: {error}
      </p>
    ) : null;
  }

  let body: React.ReactNode;
  if (status.status === "done")
    body = (
      <>
        <Parts
          description={status.description}
          map={map}
          onShowOnMap={onShowOnMap}
        />
        <span className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone="draft" className="!py-0 !leading-4">
            Drawn by {status.provider}
          </Badge>
          <Button size="sm" variant="invisible" onClick={() => start(true)}>
            Describe again
          </Button>
        </span>
      </>
    );
  else if (status.status === "running")
    body = (
      <span className="flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)]">
        <Spinner className="!h-3 !w-3" />
        Describing this change · <Elapsed since={status.startedAt} />
      </span>
    );
  else if (status.status === "failed")
    body = (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-[var(--attention)]">
        <AlertIcon size={11} />
        <span className="min-w-0 truncate" title={status.error}>
          Couldn&apos;t describe this change: {status.error}
        </span>
        <Button size="sm" onClick={() => start(true)}>
          Describe again
        </Button>
      </span>
    );
  else if (status.status === "unavailable")
    body = (
      <span className="text-[13px] text-[var(--attention)]">
        <ClaudeCodeNotice
          reason={status.reason}
          needs="Describing this change needs"
        />
      </span>
    );
  else
    body = (
      <span className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--fg-muted)]">
        <Button onClick={() => start()}>Describe this change</Button>
        {status.provider} reads the patch, its commits and its PR, read-only,
        and says what it does.
      </span>
    );

  return (
    <section>
      {body}
      {error && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-[var(--attention)]">
          <AlertIcon size={11} /> {error}
        </p>
      )}
    </section>
  );
}
