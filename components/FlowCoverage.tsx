"use client";

import { useMemo, useState } from "react";

import { coverage } from "@/lib/flows/coverage";
import type { FlowSet } from "@/lib/flows/types";
import type { DiffFile } from "@/lib/types";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import { StepCode } from "./StepCode";
import { Spinner } from "./ui";

/**
 * "20 of 23 changed hunks are on a flow · read these 3 yourself", beside the
 * Flows heading, with the rest listed beneath it. Each opens its code in
 * place, and a hunk on no flow can have one traced on demand: only the flows
 * asked for cost anything. Its parts sit in the heading's wrapping row.
 */
export function FlowCoverage({
  set,
  files,
  tracing,
  onTrace,
  repo,
  rev,
  onShowYourself,
}: {
  set: FlowSet;
  files: DiffFile[];
  tracing: string[];
  onTrace: (hunkId: string) => void;
  repo: string;
  rev: string;
  /** Files changed, filtered to the hunks on no flow */
  onShowYourself: () => void;
}) {
  const hunks = useMemo(() => coverage(set, files), [set, files]);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  if (hunks.length === 0) return null;
  const on = hunks.filter((h) => h.onFlow).length;
  const off = hunks.filter((h) => !h.onFlow);

  return (
    <>
      <span className="flow-cover">
        <button
          type="button"
          className="inline-flex items-center gap-1 disabled:cursor-default"
          disabled={off.length === 0}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {off.length > 0 &&
            (open ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            ))}
          <span>
            <b>{on}</b> of {hunks.length} changed{" "}
            {hunks.length === 1 ? "hunk is" : "hunks are"} on a flow
          </span>
        </button>
        {off.length > 0 && (
          <>
            {" · "}
            <button
              type="button"
              className="text-[var(--attention)] hover:underline"
              onClick={onShowYourself}
              title="Show them in Files changed"
            >
              read {off.length === 1 ? "this one" : `these ${off.length}`}{" "}
              yourself
            </button>
          </>
        )}
      </span>
      {open && off.length > 0 && (
        <ul className="basis-full divide-y divide-[var(--border-muted)] rounded-md border border-[var(--border)] bg-[var(--canvas)] text-[12px] font-normal normal-case tracking-normal">
          {off.map((h) => {
            const target = h.offFlow[0];
            const busy = target ? tracing.includes(target.id) : false;
            const key = `${h.file}:${h.side}:${h.line}`;
            return (
              <li key={key}>
                <div className="flex items-start gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="mono truncate text-[var(--accent)] hover:underline"
                      onClick={() =>
                        setReading((r) => (r === key ? null : key))
                      }
                    >
                      {h.file.split("/").pop()}:{h.line}
                    </button>
                    {target?.reason && (
                      <div className="text-[11px] text-[var(--fg-subtle)]">
                        {target.reason}
                      </div>
                    )}
                  </div>
                  {target && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onTrace(target.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas-subtle)] px-2 py-[2px] text-[11px] font-medium hover:border-[var(--fg-subtle)] disabled:opacity-70"
                    >
                      {busy ? (
                        <>
                          <Spinner className="!h-3 !w-3" /> Tracing…
                        </>
                      ) : (
                        "Trace a flow from here"
                      )}
                    </button>
                  )}
                </div>
                {reading === key && (
                  <StepCode
                    repo={repo}
                    rev={rev}
                    path={h.file}
                    side={h.side}
                    line={h.line}
                    height={220}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
