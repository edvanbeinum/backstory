"use client";

import { useMemo } from "react";

import { filePaths } from "@/lib/anchor";
import { WORKING_REV } from "@/lib/constants";
import type { DataResponse } from "@/lib/data/types";
import type { FlowRow } from "@/lib/flows/rows";
import type { MapResponse } from "@/lib/map";
import type { DiffResponse } from "@/lib/types";
import { DataSummary } from "./DataSummary";
import type { StoryTarget } from "./FlowCard";
import { FlowCoverage } from "./FlowCoverage";
import { Flows } from "./Flows";
import type { ComponentInfo, DataField, StepBadge } from "./FlowSequence";
import { SystemMap } from "./SystemMap";
import type { FlowsApi } from "./useFlows";

/**
 * The tab every view lands on, read top to bottom: the map at the column's
 * width with a line of what it says, then each flow as a card. Traced or
 * not, the map leads; the code is a click away from any step.
 */
export function Story({
  repo,
  rev,
  map,
  data,
  entityNotes,
  onModelChange,
  mapHighlight,
  onOpenFile,
  flows,
  diff,
  onShowFiles,
  onShowYourself,
  target,
  onTargetDone,
  onShowInFiles,
  navRef,
  components,
  dataFields,
  flowNotes,
  badges,
  onBadge,
}: {
  repo: string;
  rev: string;
  map: MapResponse | null;
  data: DataResponse | null;
  entityNotes: Map<string, string[]>;
  /** A model or data model draft was written: read both again */
  onModelChange: () => void;
  mapHighlight: { name: string; at: number } | null;
  /** A file picked on the map: show it in Files changed */
  onOpenFile: (path: string) => void;
  flows: FlowsApi;
  /** This view's diff, once it has loaded */
  diff: DiffResponse | null;
  onShowFiles: () => void;
  onShowYourself: () => void;
  target: StoryTarget | null;
  onTargetDone: (at: number) => void;
  onShowInFiles: (row: FlowRow) => void;
  navRef: React.MutableRefObject<((delta: number) => boolean) | null>;
  components: Map<string, ComponentInfo>;
  dataFields: DataField[];
  flowNotes: Map<number, string[]>;
  /** Review comments on steps, by flow index */
  badges: Map<number, Map<string, StepBadge[]>>;
  /** Open a badge's comment in Comments */
  onBadge: (threadId: string) => void;
}) {
  const filesInDiff = useMemo(
    () => (diff ? new Set(diff.files.flatMap(filePaths)) : null),
    [diff],
  );
  const status = flows.status;
  const set = status?.status === "ready" ? status.flows : null;

  return (
    <div className="space-y-6 pt-1">
      {rev !== WORKING_REV && (
        <section className="space-y-2">
          <div className="story-h">
            <h3>Map</h3>
          </div>
          <SystemMap
            map={map}
            repo={repo}
            rev={rev}
            highlight={mapHighlight}
            onOpenFile={onOpenFile}
            onModelChange={onModelChange}
          >
            <DataSummary
              data={data}
              notes={entityNotes}
              repo={repo}
              rev={rev}
              onRead={onModelChange}
            />
          </SystemMap>
        </section>
      )}

      <section className="space-y-2">
        <div className="story-h">
          <h3>Flows</h3>
          {set && <span className="counter">{set.flows.length}</span>}
          {set && diff && (
            <FlowCoverage
              set={set}
              files={diff.files}
              tracing={status?.status === "ready" ? status.tracing : []}
              onTrace={flows.trace}
              repo={repo}
              rev={rev}
              onShowYourself={onShowYourself}
            />
          )}
        </div>
        <Flows
          api={flows}
          fileCount={diff ? diff.files.length : null}
          onShowFiles={onShowFiles}
          repo={repo}
          rev={rev}
          onShowInFiles={onShowInFiles}
          filesInDiff={filesInDiff}
          target={target}
          onTargetDone={onTargetDone}
          navRef={navRef}
          components={components}
          dataFields={dataFields}
          flowNotes={flowNotes}
          badges={badges}
          onBadge={onBadge}
        />
      </section>
    </div>
  );
}
