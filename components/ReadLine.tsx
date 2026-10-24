"use client";

import type { ProviderGap } from "@/lib/ai/provider";
import type { DataDraftStatus, TrunkReadStatus } from "@/lib/data/types";
import type { DescriptionApi } from "./ChangeDescription";
import { ClaudeCodeNotice } from "./ClaudeCodeNotice";
import type { DataDraftApi } from "./DataSummary";
import { AlertIcon } from "./icons";
import type { MapDraftApi } from "./SystemMap";
import { Button, Spinner } from "./ui";

interface Failed {
  name: string;
  error: string;
  retry: (() => void) | null;
}

/** A drawing's read in the line's words: running, failed, or the provider missing. */
function readOf(
  name: string,
  job: DataDraftStatus | undefined,
  error: string | null,
  retry: () => void,
) {
  const running =
    job?.status === "running"
      ? `${name}: ${job.phase}${job.step ? ` · ${job.step.at} of ${job.step.of}` : ""}`
      : null;
  const failed: Failed[] = [];
  if (job?.status === "failed") failed.push({ name, error: job.error, retry });
  if (error) failed.push({ name, error, retry: null });
  const gap = job?.status === "unavailable" ? job.reason : null;
  return { running, failed, gap };
}

const bigRead = (read: TrunkReadStatus | null | undefined) =>
  read?.status === "running" && read.big;

/**
 * Story's one line about its reads, at the top: each running read's phase
 * and step, a failed read's error with Try again, and on a big repo a second
 * line saying the first read takes a while. Hidden when nothing runs or
 * failed.
 */
export function ReadLine({
  map,
  data,
  description,
}: {
  map: MapDraftApi;
  data: DataDraftApi;
  /** Null on uncommitted work, which has no description */
  description: DescriptionApi | null;
}) {
  const said = description?.status;
  const reads = [
    readOf("Drawing the map", map.map?.draft, map.error, map.retry),
    readOf("Reading the data model", data.data?.draft, data.error, data.retry),
  ];
  const running = reads.flatMap((r) => (r.running ? [r.running] : []));
  const failed = reads.flatMap((r) => r.failed);
  const gaps: ProviderGap[] = reads.flatMap((r) => (r.gap ? [r.gap] : []));
  if (said?.status === "running") running.push("Describing the change");
  if (said?.status === "failed")
    failed.push({
      name: "Describing the change",
      error: said.error,
      retry: () => description?.start(true),
    });
  if (said?.status === "done" && said.error)
    failed.push({
      name: "Describing the change again",
      error: said.error,
      retry: null,
    });
  if (description?.error)
    failed.push({
      name: "Describing the change",
      error: description.error,
      retry: null,
    });
  if (said?.status === "unavailable") gaps.push(said.reason);
  if (said?.status === "done" && said.gap) gaps.push(said.gap);
  const big =
    running.length > 0 &&
    (bigRead(map.map?.mainRead) || bigRead(data.data?.mainRead));

  if (running.length === 0 && failed.length === 0 && gaps.length === 0)
    return null;
  return (
    <div className="read-line" role="status">
      {running.length > 0 && (
        <p className="flex items-center gap-1.5 text-[var(--fg-muted)]">
          <Spinner className="!h-3 !w-3 shrink-0" />
          <span>{running.join(" · ")}</span>
        </p>
      )}
      {big && (
        <p className="text-[var(--fg-subtle)]">
          This is a big repo, the first read takes a while. You can leave this
          open.
        </p>
      )}
      {failed.map((f, i) => (
        <p
          key={i}
          className="flex min-w-0 items-center gap-1.5 text-[var(--attention)]"
        >
          <AlertIcon size={11} />
          <span className="min-w-0 truncate" title={f.error}>
            {f.name}: {f.error}
          </span>
          {f.retry && (
            <Button size="sm" onClick={f.retry}>
              Try again
            </Button>
          )}
        </p>
      ))}
      {gaps.length > 0 && (
        <p className="text-[var(--attention)]">
          <ClaudeCodeNotice
            reason={gaps[0]}
            needs="Drawing this change needs"
          />
        </p>
      )}
    </div>
  );
}
