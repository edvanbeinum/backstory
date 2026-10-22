"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MapResponse } from "@/lib/map";
import { viewKey, viewParams } from "@/lib/url";
import {
  isOnMap,
  startsByItself,
  type ChangeDescription as Description,
  type DescriptionResponse,
} from "@/lib/description/types";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import { AlertIcon } from "./icons";
import { Elapsed, setAutoReading } from "./SystemMap";
import { Badge, Button, Spinner, Ticked } from "./ui";
import { useView } from "./ViewContext";

/**
 * The view's description and its read, tagged with the view it answers for,
 * so a view the page has left never shows. Polls while a read runs rather
 * than adding a watch event: reads are rare.
 */
export function useDescription(
  repo: string,
  rev: string,
  onAutoChange: () => void,
) {
  const { ref } = useView();
  const view = viewKey({ repo, ref, rev });
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
      const asked = viewKey({ repo, ref, rev });
      const params = viewParams({
        repo,
        ref,
        rev,
        redraft: redraft ? "1" : null,
      });
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
    [repo, ref, rev],
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

  const setAuto = async (on: boolean) => {
    try {
      await setAutoReading(repo, on);
      onAutoChange();
      await request("GET");
    } catch (err) {
      setAnswer({
        view,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    status,
    error: shown?.error ?? null,
    start: (redraft = false) => void request("POST", redraft),
    setAuto: (on: boolean) => void setAuto(on),
  };
}

export type DescriptionApi = ReturnType<typeof useDescription>;

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
      {description.why && (
        <>
          <dt className={`${LABEL} sm:pt-0.5`}>Why</dt>
          <dd className="m-0">
            <Ticked text={description.why} />
          </dd>
        </>
      )}
      <dt className={`${LABEL} sm:pt-0.5`}>What it does</dt>
      <dd className="m-0">
        <Ticked text={description.what} />
      </dd>
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
                  {l.reason && (
                    <>
                      : <Ticked text={l.reason} />
                    </>
                  )}
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
 * Why the change was made, what it does, and where to look first, at the top
 * of Story.
 * Read by the AI provider as the view opens when the repo reads
 * automatically, or on a click.
 */
export function ChangeDescription({
  read,
  map,
  onShowOnMap,
}: {
  /** The view's description read, from `useDescription` */
  read: DescriptionApi;
  /** The map on screen, for which places to look first link to it */
  map: MapResponse | null;
  /** Outline a component on the map, or in Story's walk go to its stop */
  onShowOnMap: (name: string) => void;
}) {
  const { status, error, start, setAuto } = read;
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
          <span className="text-[11px] text-[var(--fg-subtle)]">
            {status.auto ? (
              <>
                Read automatically ·{" "}
                <button
                  type="button"
                  className="text-[var(--accent)] hover:underline"
                  onClick={() => setAuto(false)}
                >
                  Turn off
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-[var(--accent)] hover:underline"
                onClick={() => setAuto(true)}
              >
                Read automatically
              </button>
            )}
          </span>
          <Button size="sm" variant="invisible" onClick={() => start(true)}>
            Describe again
          </Button>
        </span>
        {status.gap && (
          <p className="mt-2 text-[12px] text-[var(--attention)]">
            <ClaudeCodeNotice
              reason={status.gap}
              needs="Describing this change again needs"
            />
          </p>
        )}
        {status.error && (
          <p className="mt-2 flex min-w-0 items-center gap-1 text-[12px] text-[var(--attention)]">
            <AlertIcon size={11} />
            <span className="min-w-0 truncate" title={status.error}>
              Couldn&apos;t describe this change again: {status.error}
            </span>
          </p>
        )}
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
