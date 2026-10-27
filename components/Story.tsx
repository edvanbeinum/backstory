"use client";

import { useMemo, useState } from "react";

import { filePaths } from "@/lib/anchor";
import { WORKING_REV } from "@/lib/constants";
import type { DataResponse } from "@/lib/data/types";
import { isOnMap } from "@/lib/description/types";
import type { FlowRow } from "@/lib/flows/rows";
import type { MapResponse } from "@/lib/map";
import type { DiffResponse } from "@/lib/types";
import { viewKey } from "@/lib/url";
import { ChangeDescription, useDescription } from "./ChangeDescription";
import { DataSummary, useDataDraft } from "./DataSummary";
import type { StoryTarget } from "./FlowCard";
import { FlowCoverage } from "./FlowCoverage";
import { Flows } from "./Flows";
import type { ComponentInfo, DataField, StepBadge } from "./FlowSequence";
import { NoteComposer } from "./NoteCard";
import { ReadFootnote } from "./ReadFootnote";
import { ReadLine } from "./ReadLine";
import { setAutoReading, SystemMap, useMapDraft } from "./SystemMap";
import { Button } from "./ui";
import type { FlowsApi } from "./useFlows";
import { useView } from "./ViewContext";

/**
 * A note on the change as a whole. The notes box has no note button of its
 * own, so this is where every general note is written.
 */
function NoteForAgent({ onNote }: { onNote: (body: string) => void }) {
  const [writing, setWriting] = useState(false);
  if (!writing)
    return (
      <Button size="sm" onClick={() => setWriting(true)}>
        + Note for the agent
      </Button>
    );
  // Give the composer its own full row, since it sits beside the read line.
  return (
    <div className="basis-full">
      <NoteComposer
        placeholder="Anything about the change as a whole?"
        onCancel={() => setWriting(false)}
        onSave={(body) => {
          onNote(body);
          setWriting(false);
        }}
      />
    </div>
  );
}

/**
 * The tab every view lands on, read top to bottom on one page: the
 * description, the map at the column's width with a line of what the data
 * model says, then each flow as a card. The code is a click away from any
 * step. One line at the top says which reads are running, and one footnote
 * at the bottom says what the AI drew and offers each drawing's Read again.
 */
export function Story({
  repo,
  rev,
  map,
  data,
  entityNotes,
  onModelChange,
  mapHighlight,
  onShowOnMap,
  onOpenFile,
  flows,
  diff,
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
  onNote,
}: {
  repo: string;
  rev: string;
  map: MapResponse | null;
  data: DataResponse | null;
  entityNotes: Map<string, string[]>;
  /** A model or data model draft was written: read both again */
  onModelChange: () => void;
  mapHighlight: { name: string; at: number } | null;
  /** Outline a component on the map */
  onShowOnMap: (name: string) => void;
  /** A file picked on the map: show it in Files changed */
  onOpenFile: (path: string) => void;
  flows: FlowsApi;
  /** This view's diff, once it has loaded */
  diff: DiffResponse | null;
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
  /** Save a general note; null while the change on screen is loading */
  onNote: ((body: string) => void) | null;
}) {
  const filesInDiff = useMemo(
    () => (diff ? new Set(diff.files.flatMap(filePaths)) : null),
    [diff],
  );
  const status = flows.status;
  const set = status?.status === "ready" ? status.flows : null;
  const { ref } = useView();
  const read = useDescription(repo, rev, onModelChange);
  // Story runs the drawings' reads, not the drawings, so its one progress
  // line knows each read.
  const mapDraft = useMapDraft(repo, rev, map, onModelChange);
  const dataDraft = useDataDraft(
    repo,
    rev,
    rev !== WORKING_REV ? data : null,
    onModelChange,
  );
  const describes = rev !== WORKING_REV ? read : null;
  // Gives the map card the repo's switch on uncommitted work too, where there
  // is no description to own it.
  const setAuto = async (on: boolean) => {
    await setAutoReading(repo, on);
    onModelChange();
  };
  const view = viewKey({ repo, ref, rev });

  return (
    <div className="space-y-6 pt-1">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <ReadLine map={mapDraft} data={dataDraft} description={describes} />
        </div>
        {/* Keyed by view so a half-written note never goes to the next change. */}
        {onNote && <NoteForAgent key={view} onNote={onNote} />}
      </div>

      {rev !== WORKING_REV && (
        <ChangeDescription read={read} map={map} onShowOnMap={onShowOnMap} />
      )}

      <section className="space-y-2">
        <div className="story-h">
          <h3>Map</h3>
        </div>
        <SystemMap
          draft={mapDraft}
          onSetAuto={describes?.setAuto ?? setAuto}
          repo={repo}
          rev={rev}
          highlight={mapHighlight}
          onOpenFile={onOpenFile}
        >
          <DataSummary
            draft={dataDraft}
            notes={entityNotes}
            repo={repo}
            rev={rev}
            onMap={(name) => isOnMap(name, map)}
            onShowOnMap={onShowOnMap}
          />
        </SystemMap>
      </section>

      {rev !== WORKING_REV && (
        <section className="space-y-2">
          <div className="story-h">
            <h3>Flows</h3>
            {set && diff && (
              <FlowCoverage
                set={set}
                files={diff.files}
                onShowYourself={onShowYourself}
              />
            )}
          </div>
          <Flows
            api={flows}
            fileCount={diff ? diff.files.length : null}
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
      )}
      <ReadFootnote
        map={mapDraft}
        data={dataDraft}
        description={describes}
        flows={rev !== WORKING_REV ? flows : null}
      />
    </div>
  );
}
