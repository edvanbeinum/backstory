"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { filePaths } from "@/lib/anchor";
import { WORKING_REV } from "@/lib/constants";
import type { DataResponse } from "@/lib/data/types";
import type { FlowRow, StepMark } from "@/lib/flows/rows";
import type { MapResponse } from "@/lib/map";
import type { DiffFile, DiffResponse } from "@/lib/types";
import { resolveStop, viewKey } from "@/lib/url";
import { buildStops } from "@/lib/walk";
import { ChangeDescription, useDescription } from "./ChangeDescription";
import { DataSummary } from "./DataSummary";
import type { StoryTarget } from "./FlowCard";
import { FlowCoverage } from "./FlowCoverage";
import { Flows } from "./Flows";
import type { ComponentInfo, DataField, StepBadge } from "./FlowSequence";
import { SystemMap } from "./SystemMap";
import { Button } from "./ui";
import type { FlowsApi } from "./useFlows";
import { useView } from "./ViewContext";
import { StopView, WalkBar } from "./Walk";

/**
 * The tab every view lands on. It opens as a walk through the change, one
 * stop at a time under the pinned map: an overview with the description,
 * the data model when it changed, each changed component in the map's
 * order, the files no component has, and a finish with your notes. Show
 * everything on one page reads it top to bottom instead: the description,
 * the map at the column's width with a line of what it says, then each flow
 * as a card. The code is a click away from any step.
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
  walk,
  stop,
  onStop,
  onWalk,
  walkNavRef,
  renderFiles,
  onNote,
  onStep,
}: {
  repo: string;
  rev: string;
  map: MapResponse | null;
  data: DataResponse | null;
  entityNotes: Map<string, string[]>;
  /** A model or data model draft was written: read both again */
  onModelChange: () => void;
  mapHighlight: { name: string; at: number } | null;
  /** Outline a component on the map, from the change description */
  onShowOnMap: (name: string) => void;
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
  /** Story walks through the change rather than showing it on one page */
  walk: boolean;
  /** The stop the walk is on, from 1, as the URL names it */
  stop: number;
  onStop: (stop: number) => void;
  onWalk: (on: boolean) => void;
  /** Set while walk: moves `delta` stops, for j and k */
  walkNavRef: React.MutableRefObject<((delta: number) => boolean) | null>;
  /** Files as Files changed draws them, taking line notes */
  renderFiles: (files: DiffFile[]) => React.ReactNode;
  /** Save a general note; null while the change on screen is loading */
  onNote: ((body: string) => void) | null;
  /** Open a flow step, leaving the walk */
  onStep: (mark: StepMark) => void;
}) {
  const filesInDiff = useMemo(
    () => (diff ? new Set(diff.files.flatMap(filePaths)) : null),
    [diff],
  );
  const status = flows.status;
  const set = status?.status === "ready" ? status.flows : null;
  const { ref } = useView();
  const read = useDescription(repo, rev, onModelChange);
  const description =
    read.status?.status === "done" ? read.status.description : null;
  const shownMap = rev !== WORKING_REV ? map : null;

  const stops = useMemo(
    () =>
      buildStops({
        description,
        map: shownMap,
        data,
        flows: set,
        files: diff?.files ?? [],
      }),
    [description, shownMap, data, set, diff],
  );
  const index = resolveStop(stop, stops.length);
  const current = stops[index];

  // The file headers in a stop stick under the pinned bar and map, so they
  // need its height.
  const topRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(0);
  useEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTopHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [walk]);

  // The stops seen on this view, kept only for the view they were seen on.
  const view = viewKey({ repo, ref, rev });
  const [seen, setSeen] = useState({ view, keys: new Set<string>() });
  if (seen.view !== view) setSeen({ view, keys: new Set() });
  else if (walk && !seen.keys.has(current.key))
    setSeen({ view, keys: new Set([...seen.keys, current.key]) });

  const go = (i: number) => {
    onStop(Math.max(0, Math.min(i, stops.length - 1)) + 1);
    window.scrollTo({ top: 0 });
  };
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  useEffect(() => {
    if (!walk) return;
    walkNavRef.current = (delta) => {
      goRef.current(index + delta);
      return true;
    };
    return () => {
      walkNavRef.current = null;
    };
  }, [walk, index, walkNavRef]);

  const toStop = (name: string) => {
    const i = stops.findIndex(
      (s) => s.kind === "component" && s.node.name === name,
    );
    if (i === -1) onShowOnMap(name);
    else go(i);
  };

  const overview =
    rev !== WORKING_REV ? (
      <ChangeDescription
        read={read}
        map={map}
        onShowOnMap={walk ? toStop : onShowOnMap}
      />
    ) : null;

  const mapSection = (focused: boolean) => (
    <SystemMap
      map={map}
      repo={repo}
      rev={rev}
      highlight={mapHighlight}
      onOpenFile={onOpenFile}
      onModelChange={onModelChange}
      {...(focused && {
        focus:
          current.kind === "component"
            ? { node: current.node.id, edges: current.edges }
            : null,
        onPickNode: (id: string) => {
          const i = stops.findIndex((s) => s.key === `component:${id}`);
          if (i !== -1) go(i);
        },
      })}
    >
      <DataSummary
        data={data}
        notes={entityNotes}
        repo={repo}
        rev={rev}
        onRead={onModelChange}
        phraseOnly={focused}
      />
    </SystemMap>
  );

  if (walk)
    return (
      <div className="pt-1">
        <div ref={topRef} className="walk-top">
          <WalkBar
            stops={stops}
            index={index}
            seen={seen.keys}
            onGo={go}
            onLeave={() => onWalk(false)}
          />
          {rev !== WORKING_REV && (
            <div className="walk-map">{mapSection(true)}</div>
          )}
        </div>
        <div
          className="walk-stop"
          style={{ "--walk-top": `${topHeight}px` } as React.CSSProperties}
        >
          <StopView
            key={current.key}
            stops={stops}
            index={index}
            seen={seen.keys}
            overview={overview}
            data={data}
            entityNotes={entityNotes}
            renderFiles={renderFiles}
            onNote={onNote}
            onStep={onStep}
            onGo={go}
          />
        </div>
      </div>
    );

  return (
    <div className="space-y-6 pt-1">
      <div className="flex justify-end">
        <Button size="sm" variant="invisible" onClick={() => onWalk(true)}>
          Walk me through it
        </Button>
      </div>

      {overview}

      {rev !== WORKING_REV && (
        <section className="space-y-2">
          <div className="story-h">
            <h3>Map</h3>
          </div>
          {mapSection(false)}
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
