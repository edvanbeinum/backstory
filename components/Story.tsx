"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { filePaths } from "@/lib/anchor";
import { WORKING_REV } from "@/lib/constants";
import type { DataResponse } from "@/lib/data/types";
import type { FlowRow, StepMark } from "@/lib/flows/rows";
import type { MapResponse } from "@/lib/map";
import type { DiffFile, DiffResponse } from "@/lib/types";
import { resolveStop, viewKey } from "@/lib/url";
import { buildStops } from "@/lib/walk";
import { ChangeDescription, useDescription } from "./ChangeDescription";
import { DataSummary, useDataDraft } from "./DataSummary";
import type { StoryTarget } from "./FlowCard";
import { FlowCoverage } from "./FlowCoverage";
import { Flows } from "./Flows";
import type { ComponentInfo, DataField, StepBadge } from "./FlowSequence";
import { ReadFootnote } from "./ReadFootnote";
import { ReadLine } from "./ReadLine";
import {
  mapDrawing,
  setAutoReading,
  SystemMap,
  useMapDraft,
} from "./SystemMap";
import { Button } from "./ui";
import type { FlowsApi } from "./useFlows";
import { useView } from "./ViewContext";
import { NoteFor, StopView, WalkBar } from "./Walk";

/**
 * The tab every view lands on. It opens as a walk through the change, one
 * stop at a time under a pinned bar: an overview with the description and
 * the map, the data model when it changed, each changed component in the
 * map's order with the map outlining it, the files no component has, and a
 * finish with your notes. Show
 * everything on one page reads it top to bottom instead: the description,
 * the map at the column's width with a line of what it says, then each flow
 * as a card. The code is a click away from any step. One line at the top
 * says which reads are running, and one footnote at the bottom says what the
 * AI drew and offers each drawing's Read again.
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
  // Story holds the drawings' reads, not the drawings, so its one progress
  // line knows each read and the data model reads in the walk, whose maps
  // show no data phrase.
  const mapDraft = useMapDraft(repo, rev, map, onModelChange);
  const drawing = mapDrawing(mapDraft.map);
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
  const readLine = (
    <ReadLine map={mapDraft} data={dataDraft} description={describes} />
  );
  // Keep the flows out of the walk's footnote, since only the Flows section on
  // one page shows a trace running or failing.
  const footnote = (
    <ReadFootnote
      map={mapDraft}
      data={dataDraft}
      description={describes}
      flows={rev !== WORKING_REV && !walk ? flows : null}
    />
  );
  const view = viewKey({ repo, ref, rev });
  const [drawn, setDrawn] = useState<{ view: string; ids: string[] } | null>(
    null,
  );
  const order = drawn?.view === view ? drawn.ids : null;
  const onOrder = useCallback(
    (ids: string[]) =>
      setDrawn((was) =>
        was?.view === view && was.ids.join("\n") === ids.join("\n")
          ? was
          : { view, ids },
      ),
    [view],
  );

  const stops = useMemo(
    () =>
      buildStops({
        description,
        map,
        order,
        data,
        flows: set,
        files: diff?.files ?? [],
      }),
    [description, map, order, data, set, diff],
  );
  // Keep the stop picked on screen when a late map, data model or diff adds
  // stops before it, rather than the stop now at its number. A stop number
  // from a link is left alone, since the stops settle after it opens. Drop
  // the pick on another view, whose stops may share its key or number.
  const [picked, setPicked] = useState<{
    view: string;
    stop: number;
    key: string;
  } | null>(null);
  const atUrl = resolveStop(stop, stops.length);
  const pick = picked?.view === view ? picked : null;
  if (pick && pick.stop !== stop && stops[atUrl].key === pick.key)
    setPicked({ ...pick, stop });
  const pickedAt =
    pick?.stop === stop ? stops.findIndex((s) => s.key === pick.key) : -1;
  const index = pickedAt !== -1 ? pickedAt : atUrl;
  const current = stops[index];
  useEffect(() => {
    if (pickedAt !== -1 && pickedAt + 1 !== stop) onStop(pickedAt + 1);
  }, [pickedAt, stop, onStop]);

  // The file headers in a stop stick under the pinned bar, so they need its
  // height.
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
  const [seen, setSeen] = useState({ view, keys: new Set<string>() });
  if (seen.view !== view) setSeen({ view, keys: new Set() });
  else if (walk && !seen.keys.has(current.key))
    setSeen({ view, keys: new Set([...seen.keys, current.key]) });

  const go = (i: number) => {
    const to = Math.max(0, Math.min(i, stops.length - 1));
    setPicked({ view, stop: to + 1, key: stops[to].key });
    onStop(to + 1);
    window.scrollTo({ top: 0 });
  };
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  useEffect(() => {
    if (!walk) return;
    walkNavRef.current = (delta) => {
      const to = index + delta;
      if (to < 0 || to >= stops.length) return false;
      goRef.current(to);
      return true;
    };
    return () => {
      walkNavRef.current = null;
    };
  }, [walk, index, stops.length, walkNavRef]);

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
      draft={mapDraft}
      onSetAuto={describes?.setAuto ?? setAuto}
      repo={repo}
      rev={rev}
      highlight={mapHighlight}
      onOpenFile={onOpenFile}
      onOrder={onOrder}
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
      {!focused && (
        <DataSummary
          draft={dataDraft}
          notes={entityNotes}
          repo={repo}
          rev={rev}
          onShowOnMap={onShowOnMap}
        />
      )}
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
            drawing={drawing}
            onGo={go}
            onLeave={() => onWalk(false)}
          />
          {readLine}
        </div>
        <div
          className="walk-stop"
          style={{ "--walk-top": `${topHeight}px` } as React.CSSProperties}
        >
          <StopView
            key={`${view} ${current.key}`}
            stops={stops}
            index={index}
            seen={seen.keys}
            overview={
              <>
                {overview}
                {mapSection(true)}
              </>
            }
            drawing={drawing}
            map={mapSection(true)}
            data={data}
            entityNotes={entityNotes}
            renderFiles={renderFiles}
            onNote={onNote}
            onStep={onStep}
            onGo={go}
            onShowOnMap={toStop}
          />
          {footnote}
        </div>
      </div>
    );

  return (
    <div className="space-y-6 pt-1">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">{readLine}</div>
        <Button size="sm" onClick={() => onWalk(true)}>
          Walk me through it
        </Button>
        {/* Keyed by view so a half-written note never goes to the next change. */}
        {onNote && <NoteFor key={view} onNote={onNote} />}
      </div>

      {overview}

      <section className="space-y-2">
        <div className="story-h">
          <h3>Map</h3>
        </div>
        {mapSection(false)}
      </section>

      {rev !== WORKING_REV && (
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
      {footnote}
    </div>
  );
}
