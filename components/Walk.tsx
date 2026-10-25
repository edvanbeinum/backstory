"use client";

import { useState } from "react";

import type { DataResponse } from "@/lib/data/types";
import type { StepMark } from "@/lib/flows/rows";
import type { DiffFile } from "@/lib/types";
import { filesNotSeen, type Stop } from "@/lib/walk";
import { DataCards } from "./DataSummary";
import { NoteComposer } from "./NoteCard";
import { Button, Ticked } from "./ui";

/**
 * Story's walk on screen: the bar that moves between stops, and the stop
 * it's on. The UI says neither "walk" nor "stop": the bar reads "3 of 6".
 */

function stopName(stop: Stop): string {
  switch (stop.kind) {
    case "overview":
      return "Overview";
    case "data":
      return "Data model";
    case "component":
      return stop.node.name;
    case "yourself":
      return "Not on the map";
    case "finish":
      return "Your notes";
  }
}

const fileWord = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

export function WalkBar({
  stops,
  index,
  seen,
  drawing,
  onGo,
  onLeave,
}: {
  stops: Stop[];
  index: number;
  seen: Set<string>;
  /** While the map is drawing, which leaves out the stops it will add */
  drawing: boolean;
  onGo: (index: number) => void;
  /** Show everything on one page */
  onLeave: () => void;
}) {
  return (
    <div className="walk-bar">
      <span className="walk-where">
        {!drawing && (
          <>
            <b>
              {index + 1} of {stops.length}
            </b>{" "}
            ·{" "}
          </>
        )}
        {stopName(stops[index])}
      </span>
      {!drawing && (
        <span className="walk-dots">
          {stops.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-label={`${i + 1}: ${stopName(s)}`}
              aria-current={i === index ? "step" : undefined}
              title={stopName(s)}
              className={`walk-dot ${seen.has(s.key) ? "seen" : ""}`}
              onClick={() => onGo(i)}
            />
          ))}
        </span>
      )}
      <span className="flex-1" />
      <Button
        size="sm"
        title="Back (k)"
        disabled={index === 0}
        onClick={() => onGo(index - 1)}
      >
        ‹
      </Button>
      <Button
        size="sm"
        title="Next (j)"
        disabled={index === stops.length - 1}
        onClick={() => onGo(index + 1)}
      >
        ›
      </Button>
      <Button size="sm" variant="invisible" onClick={onLeave}>
        Show everything on one page
      </Button>
    </div>
  );
}

function StopHeading({
  title,
  aside,
}: {
  title: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="walk-h">
      <h3>{title}</h3>
      {aside && <span>{aside}</span>}
    </div>
  );
}

/** A note on the change as a whole, starting with the component it's about. */
function NoteFor({
  name,
  onNote,
}: {
  name: string;
  onNote: (body: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  if (!writing)
    return (
      <Button size="sm" onClick={() => setWriting(true)}>
        + Note for the agent
      </Button>
    );
  return (
    <NoteComposer
      initial={`On ${name}: `}
      placeholder={`Anything about ${name}?`}
      onCancel={() => setWriting(false)}
      onSave={(body) => {
        onNote(body);
        setWriting(false);
      }}
    />
  );
}

export function StopView({
  stops,
  index,
  seen,
  overview,
  drawing,
  map,
  data,
  entityNotes,
  renderFiles,
  onNote,
  onStep,
  onGo,
}: {
  stops: Stop[];
  index: number;
  seen: Set<string>;
  /** The change description with the map under it, for the overview */
  overview: React.ReactNode;
  /** While the map is drawing, which leaves out the stops it will add */
  drawing: boolean;
  /** The map, outlining the component a stop is on */
  map: React.ReactNode;
  data: DataResponse | null;
  entityNotes: Map<string, string[]>;
  /** The files as Files changed draws them, taking line notes */
  renderFiles: (files: DiffFile[]) => React.ReactNode;
  /** Save a general note; null while the change on screen is loading */
  onNote: ((body: string) => void) | null;
  /** Open a flow step in Story on one page */
  onStep: (mark: StepMark) => void;
  onGo: (index: number) => void;
}) {
  const stop = stops[index];
  switch (stop.kind) {
    case "overview": {
      const ahead = stops.slice(1, -1);
      return (
        <section className="space-y-4">
          {overview}
          {!drawing && ahead.length > 0 && (
            <p className="walk-ahead">
              Then{" "}
              {ahead.map((s, i) => (
                <span key={s.key}>
                  {i > 0 && " · "}
                  <button type="button" onClick={() => onGo(i + 1)}>
                    {stopName(s)}
                  </button>
                </span>
              ))}
            </p>
          )}
        </section>
      );
    }
    case "data":
      return (
        <section className="space-y-3">
          <StopHeading title="Data model" />
          {data && <DataCards data={data} notes={entityNotes} />}
        </section>
      );
    case "component":
      return (
        <section className="space-y-3">
          <StopHeading
            title={stop.node.name}
            aside={
              <>
                {stop.container && <>In {stop.container} · </>}
                {fileWord(stop.files.length)}
              </>
            }
          />
          {stop.sentence && (
            <p className="text-[14px]">
              <Ticked text={stop.sentence} />
            </p>
          )}
          {stop.steps.length > 0 && (
            <p className="walk-steps">
              <span>On the flows at</span>
              {stop.steps.map((mark) => (
                <button
                  key={mark.key}
                  type="button"
                  className="mono"
                  title={`Open flow ${mark.flow + 1} at this step`}
                  onClick={() => onStep(mark)}
                >
                  ⇄ {mark.chip}
                </button>
              ))}
            </p>
          )}
          {map}
          {onNote && <NoteFor name={stop.node.name} onNote={onNote} />}
          {renderFiles(stop.files)}
        </section>
      );
    case "yourself":
      return (
        <section className="space-y-3">
          <StopHeading
            title="Not on the map"
            aside={`${fileWord(stop.files.length)} no component on the map has`}
          />
          {renderFiles(stop.files)}
        </section>
      );
    case "finish": {
      const left = filesNotSeen(stops, seen);
      return (
        <section className="walk-finish space-y-3">
          <StopHeading title="Your notes" />
          {left.length === 0 ? (
            <p className="text-[14px]">You&apos;ve seen the whole change.</p>
          ) : (
            <div className="text-[13px]">
              <p>Not seen yet:</p>
              <ul className="mt-1 space-y-0.5">
                {left.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="mono text-[12px] text-[var(--accent)] hover:underline"
                      onClick={() =>
                        onGo(stops.findIndex((s) => s.files.includes(f)))
                      }
                    >
                      {f.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      );
    }
  }
}
