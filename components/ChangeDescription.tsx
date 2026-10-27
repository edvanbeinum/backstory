"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { WORKING_REV } from "@/lib/constants";
import type { MapResponse } from "@/lib/map";
import { viewKey, viewParams } from "@/lib/url";
import {
  isOnMap,
  startsByItself,
  type ChangeDescription as Description,
  type DescriptionResponse,
} from "@/lib/description/types";
import { setAutoReading } from "./SystemMap";
import { Button, Ticked } from "./ui";
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

  // Ask for none on uncommitted work, which Story shows no description for.
  useEffect(() => {
    if (rev !== WORKING_REV) void request("GET");
  }, [request, rev]);

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

  // Lets a failed switch reach the caller rather than storing it as the
  // description's error, since the switch is the repo's, not the description's.
  const setAuto = async (on: boolean) => {
    await setAutoReading(repo, on);
    onAutoChange();
    await request("GET");
  };

  return {
    status,
    error: shown?.error ?? null,
    start: (redraft = false) => void request("POST", redraft),
    setAuto,
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
 * automatically, or on a click. Its read's progress and errors are on
 * Story's progress line.
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
  /** Outline a component on the map */
  onShowOnMap: (name: string) => void;
}) {
  const { status, start } = read;
  if (status?.status === "idle" && !status.auto)
    return (
      <section>
        <Button onClick={() => start()}>Describe this change</Button>
      </section>
    );
  if (status?.status !== "done") return null;
  return (
    <section>
      <Parts
        description={status.description}
        map={map}
        onShowOnMap={onShowOnMap}
      />
    </section>
  );
}
