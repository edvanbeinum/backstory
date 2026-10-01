"use client";

import { useMemo, useState } from "react";

import { coverage } from "@/lib/flows/coverage";
import type { FlowSet } from "@/lib/flows/types";
import type { DiffFile } from "@/lib/types";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import { Spinner } from "./ui";

/**
 * "3 of 4 changed hunks are on a flow", with the rest named, as unmapped
 * files are on the map. A hunk on no flow can have one traced on demand:
 * only the flows asked for cost anything.
 */
export function FlowCoverage({
  set,
  files,
  tracing,
  onTrace,
}: {
  set: FlowSet;
  files: DiffFile[];
  tracing: string[];
  onTrace: (hunkId: string) => void;
}) {
  const hunks = useMemo(() => coverage(set, files), [set, files]);
  const [open, setOpen] = useState(false);
  if (hunks.length === 0) return null;
  const on = hunks.filter((h) => h.onFlow).length;
  const off = hunks.filter((h) => !h.onFlow);

  const jump = (file: string, side: "old" | "new", line: number) => {
    const section = document.getElementById(`file-${encodeURIComponent(file)}`);
    const row = section?.querySelector<HTMLElement>(`tr[data-${side}-line="${line}"]`);
    (row ?? section)?.scrollIntoView({ block: "center" });
  };

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--canvas)] text-[12px]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[var(--fg-muted)] disabled:cursor-default"
        disabled={off.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {off.length > 0 &&
          (open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />)}
        <span>
          <b className="font-semibold text-[var(--fg)]">{on}</b> of {hunks.length} changed{" "}
          {hunks.length === 1 ? "hunk is" : "hunks are"} on a flow
          {off.length > 0 && <> · {off.length} not</>}
        </span>
      </button>
      {open && off.length > 0 && (
        <ul className="divide-y divide-[var(--border-muted)] border-t border-[var(--border-muted)]">
          {off.map((h) => {
            const target = h.offFlow[0];
            const busy = target ? tracing.includes(target.id) : false;
            return (
              <li key={`${h.file}:${h.side}:${h.line}`} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="mono truncate text-[var(--accent)] hover:underline"
                    onClick={() => jump(h.file, h.side, h.line)}
                  >
                    {h.file.split("/").pop()}:{h.line}
                  </button>
                  {target?.reason && (
                    <div className="text-[11px] text-[var(--fg-subtle)]">{target.reason}</div>
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
