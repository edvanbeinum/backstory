"use client";

import { useEffect, useState } from "react";

import type { Snippet } from "@/lib/snippet";
import { viewParams } from "@/lib/url";
import { Spinner } from "./ui";
import { useView } from "./ViewContext";

/** Height of the inline code under a flow step; fixed, so the diagram's rows stay on their grid. */
export const STEP_CODE_H = 268;

/**
 * The code under a flow step: a few lines around its call, coloured as the
 * diff colours them. Code on demand, under a step in the story.
 */
export function StepCode({
  repo,
  rev,
  path,
  side,
  line,
  onShowInFiles,
  notInDiff = false,
  height = STEP_CODE_H,
}: {
  repo: string;
  rev: string;
  path: string;
  side: "old" | "new";
  line: number;
  onShowInFiles?: () => void;
  /** The file isn't one the change touches, so Files changed can't show it */
  notInDiff?: boolean;
  height?: number;
}) {
  const [data, setData] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ref } = useView();
  const snippetKey = [repo, ref, rev, path, side, line].join("\0");
  const [shownKey, setShownKey] = useState(snippetKey);
  if (shownKey !== snippetKey) {
    setShownKey(snippetKey);
    setData(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const params = viewParams({
      repo,
      ref,
      rev,
      path,
      side,
      line: String(line),
    });
    fetch(`/api/snippet?${params}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(body.error ?? "Couldn't load the code.");
        else setData(body as Snippet);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [repo, ref, rev, path, side, line]);

  return (
    <div
      className="step-code"
      style={{ height }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="step-code-head">
        <span className="mono truncate">
          {path}:{line}
        </span>
        {data && !data.changed && (
          <span className="hint">unchanged in this view</span>
        )}
        {side === "old" && <span className="hint">as it was before</span>}
        <span className="flex-1" />
        {notInDiff ? (
          <span className="hint">not in this diff</span>
        ) : (
          onShowInFiles && (
            <button
              type="button"
              onClick={onShowInFiles}
              className="text-[var(--accent)] hover:underline"
            >
              Show in Files changed
            </button>
          )
        )}
      </div>
      <div className="thin-scroll step-code-body">
        {error ? (
          <p className="px-3 py-3 text-[12px] text-[var(--fg-muted)]">
            {error}
          </p>
        ) : !data ? (
          <p className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--fg-muted)]">
            <Spinner /> Loading the code…
          </p>
        ) : (
          <table className="diff-table">
            <tbody>
              {data.file.hunks[0].lines.map((l, i) => (
                <tr
                  key={i}
                  className={`${l.type === "add" ? "line-add" : l.type === "del" ? "line-del" : ""} ${
                    i === data.target ? "step-code-target" : ""
                  }`}
                >
                  <td className="diff-num">{l.oldNo ?? ""}</td>
                  <td className="diff-num">{l.newNo ?? ""}</td>
                  <td className="diff-marker">
                    {l.type === "add" ? "+" : l.type === "del" ? "-" : ""}
                  </td>
                  <td
                    className="diff-code"
                    dangerouslySetInnerHTML={{ __html: l.html ?? "" }}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
