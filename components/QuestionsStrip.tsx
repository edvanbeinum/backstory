"use client";

import { useEffect, useRef, useState } from "react";

import type { Finding } from "@/lib/findings";
import { ChevronDownIcon } from "./icons";

/**
 * Design questions the change raises, under the map and the data. One line
 * says how many and of what; it opens to each question, why it's worth
 * asking, and the steps or fields it fired on, which jump to the flow.
 */
export function QuestionsStrip({
  findings,
  ready,
  onShowStep,
}: {
  findings: Finding[];
  /** False until the flows are traced: the checks read them */
  ready: boolean;
  onShowStep: (flow: number, step: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!ready) return null;
  if (findings.length === 0) {
    return (
      <div className="map-strip quiet">
        <span className="text-[13px] font-semibold">Design questions</span>
        <span className="text-[12px] text-[var(--fg-muted)]">· none raised by this change&apos;s flows or data</span>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="map-strip">
      <div className="questions-glyph" aria-hidden="true">
        <span>{findings.length}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">Design questions</div>
        <div className="truncate text-[12px] text-[var(--fg-muted)]">
          {findings.map((f, i) => (
            <span key={f.id}>
              {i > 0 && " · "}
              {f.short}
            </span>
          ))}
        </div>
      </div>
      <button type="button" className="map-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide questions" : "Show questions"}
        <ChevronDownIcon size={12} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="map-overlay">
          <div className="space-y-2">
            {findings.map((f) => (
              <div key={f.id} className="question">
                <div className="question-title">{f.title}?</div>
                <p className="question-why">{f.why}</p>
                <ul className="question-evidence">
                  {f.evidence.map((e, i) => (
                    <li key={i}>
                      {e.flow !== undefined && e.step ? (
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            onShowStep(e.flow!, e.step!);
                          }}
                          title="Show this step in its flow"
                        >
                          {e.text}
                        </button>
                      ) : (
                        <span>{e.text}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--fg-subtle)]">
            Raised by rules over the flows and the data model, not by Claude: each is a question to
            consider, with what it fired on.
          </p>
        </div>
      )}
    </div>
  );
}
