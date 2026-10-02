"use client";

import { useState } from "react";

import type { Finding } from "@/lib/findings";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

/**
 * An index of the notes pinned on the diagrams: facts about the change's
 * shape worth a look, each opening to its evidence, which jumps to the step.
 * Quiet, and absent when there's nothing to point at.
 */
export function WorthALook({
  findings,
  onShowStep,
}: {
  findings: Finding[];
  onShowStep: (flow: number, step: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (findings.length === 0) return null;
  return (
    <div className="look">
      <button type="button" className="look-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="look-label">Worth a look</span>
        <span className="look-items">
          {findings.map((f, i) => (
            <span key={f.id}>
              {i > 0 && " · "}
              {f.short}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ul className="look-list">
          {findings.map((f) => (
            <li key={f.id}>
              <div className="look-title">{f.title}</div>
              <ul className="look-evidence">
                {f.evidence.map((e, i) => (
                  <li key={i}>
                    {e.flow !== undefined && e.step ? (
                      <button type="button" onClick={() => onShowStep(e.flow!, e.step!)} title="Show this step in its flow">
                        {e.text}
                      </button>
                    ) : (
                      <span>{e.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
