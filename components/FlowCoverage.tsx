"use client";

import { useMemo } from "react";

import { coverage } from "@/lib/flows/coverage";
import type { FlowSet } from "@/lib/flows/types";
import type { DiffFile } from "@/lib/types";

/**
 * "3 changes no flow reaches", beside the Flows heading, opening Files
 * changed on those hunks; nothing when every hunk is on a flow.
 */
export function FlowCoverage({
  set,
  files,
  onShowYourself,
}: {
  set: FlowSet;
  files: DiffFile[];
  /** Files changed, filtered to the hunks on no flow */
  onShowYourself: () => void;
}) {
  const off = useMemo(
    () => coverage(set, files).filter((h) => !h.onFlow).length,
    [set, files],
  );
  if (off === 0) return null;
  return (
    <span className="flow-cover">
      <button
        type="button"
        className="text-[var(--attention)] hover:underline"
        onClick={onShowYourself}
        title="Show them in Files changed"
      >
        {off} {off === 1 ? "change" : "changes"} no flow reaches
      </button>
    </span>
  );
}
