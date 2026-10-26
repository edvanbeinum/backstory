"use client";

import { useState } from "react";
import type { DescriptionApi } from "./ChangeDescription";
import type { DataDraftApi } from "./DataSummary";
import type { MapDraftApi } from "./SystemMap";
import type { FlowsApi } from "./useFlows";

const LINK = "text-[var(--accent)] hover:underline disabled:opacity-50";

/**
 * Story's one footnote, once the AI drew anything on the page: who drew it,
 * the repo's switch for reading as it opens, and one Read again per drawing.
 * Each Read again is its own, since on a big repo reading main again in full
 * is the whole first open again for someone who wanted a fresh description.
 */
export function ReadFootnote({
  map,
  data,
  description,
  flows,
}: {
  map: MapDraftApi;
  data: DataDraftApi;
  /** Null on uncommitted work, which has no description */
  description: DescriptionApi | null;
  /** Null on uncommitted work, which has no flows */
  flows: FlowsApi | null;
}) {
  const [switchError, setSwitchError] = useState<string | null>(null);
  const said = description?.status;
  const drawnMap = map.map?.source === "drafted" ? map.map : null;
  const drawnData = data.data?.drafted ? data.data : null;
  const described = said?.status === "done" ? said : null;
  const traced = flows?.status?.status === "ready" ? flows.status : null;
  if (!drawnMap && !drawnData && !described && !traced) return null;

  const provider =
    described?.provider ??
    drawnData?.drafted?.provider ??
    (drawnMap?.draft?.status === "idle" ? drawnMap.draft.provider : null) ??
    "Claude Code";
  // Reads the switch from an unread description too, since traced flows alone
  // don't report it; with no report at all the switch isn't shown.
  const auto =
    drawnMap?.auto ??
    drawnData?.auto ??
    described?.auto ??
    (said?.status === "idle" ? said.auto : null);
  const setAuto = (on: boolean) =>
    description?.setAuto(on).then(
      () => setSwitchError(null),
      (err: unknown) =>
        setSwitchError(err instanceof Error ? err.message : String(err)),
    );
  const parts: React.ReactNode[] = [`Drawn by ${provider}`];
  if (description && auto !== null)
    parts.push(
      <button type="button" className={LINK} onClick={() => setAuto(!auto)}>
        {auto ? "Turn off" : "Read automatically"}
      </button>,
    );
  if (switchError)
    parts.push(
      <span className="text-[var(--attention)]" title={switchError}>
        {auto ? "Couldn't turn off" : "Couldn't turn on"}: {switchError}
      </span>,
    );
  if (drawnMap)
    parts.push(
      <button
        type="button"
        className={LINK}
        disabled={drawnMap.draft?.status === "running"}
        onClick={() => {
          if (
            window.confirm(
              `Draw the map again? ${provider} reads main again in full and works out this view from it, which can take a few minutes on your account. Every other map is worked out again as you open it. The current map is kept if it fails.`,
            )
          )
            map.start(true);
        }}
      >
        Draw the map again
      </button>,
    );
  if (drawnData)
    parts.push(
      <button
        type="button"
        className={LINK}
        disabled={drawnData.draft?.status === "running"}
        onClick={() => {
          if (
            window.confirm(
              `Read the data model again? ${provider} reads main's data model again in full and works out this view from it, which can take a few minutes on your account. Every other data model is worked out again as you open it. The current reading is kept if it fails.`,
            )
          )
            data.start(true);
        }}
      >
        Read the data model again
      </button>,
    );
  if (described)
    parts.push(
      <button
        type="button"
        className={LINK}
        onClick={() => description?.start(true)}
      >
        Describe again
      </button>,
    );
  if (traced)
    parts.push(
      <button
        type="button"
        className={LINK}
        disabled={traced.tracing.length > 0}
        onClick={() => flows?.regenerate()}
      >
        Trace again
      </button>,
    );

  return (
    <p className="read-footnote">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {part}
        </span>
      ))}
    </p>
  );
}
