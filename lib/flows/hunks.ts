import type { FlowHunk } from "./types";

/**
 * Zero-context hunks. Line mapping has to use these, not the 3-line-context
 * hunks the diff view shows: with context, every step near a change would
 * read as changed, and at full context every step in the file would.
 */
export interface Hunk {
  id: string;
  file: string;
  /** The file's path at the base; differs from `file` for a rename */
  oldFile: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  text: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff -U0` output. Paths come from the ---/+++ lines. */
export function parseZeroContext(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let oldFile: string | null = null;
  let newFile: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldFile = newFile = null;
    } else if (line.startsWith("--- ")) {
      oldFile = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      newFile = stripPrefix(line.slice(4));
    } else if (line.startsWith("@@")) {
      const m = line.match(HUNK_HEADER);
      if (!m) continue;
      const file = newFile ?? oldFile;
      if (!file) continue;
      out.push({
        id: `H${out.length + 1}`,
        file,
        oldFile: oldFile ?? file,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        text: [],
      });
    } else if (out.length && (line.startsWith("+") || line.startsWith("-"))) {
      out[out.length - 1].text.push(line);
    }
  }
  return out;
}

function stripPrefix(raw: string): string | null {
  const p = raw.replace(/\t.*$/, "");
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * A base line's number at the head, or null if the diff changed or deleted
 * it. With -U0, an old range of 0 lines is a pure insertion after `oldStart`.
 */
export function mapOldToNew(
  hunks: Pick<Hunk, "oldFile" | "oldStart" | "oldLines" | "newLines">[],
  file: string,
  line: number,
): number | null {
  let shift = 0;
  for (const h of hunks) {
    if (h.oldFile !== file) continue;
    if (h.oldLines > 0) {
      if (line >= h.oldStart && line < h.oldStart + h.oldLines) return null;
      if (line >= h.oldStart + h.oldLines) shift += h.newLines - h.oldLines;
    } else if (line > h.oldStart) {
      shift += h.newLines;
    }
  }
  return line + shift;
}

/** The reverse: a head line's number at the base, or null if it's new. */
export function mapNewToOld(
  hunks: Pick<Hunk, "file" | "newStart" | "newLines" | "oldLines">[],
  file: string,
  line: number,
): number | null {
  let shift = 0;
  for (const h of hunks) {
    if (h.file !== file) continue;
    if (h.newLines > 0) {
      if (line >= h.newStart && line < h.newStart + h.newLines) return null;
      if (line >= h.newStart + h.newLines) shift += h.oldLines - h.newLines;
    } else if (line > h.newStart) {
      shift += h.oldLines;
    }
  }
  return line + shift;
}

/** Is this head line one the diff added? */
export function isAddedLine(
  hunks: Pick<FlowHunk, "file" | "newStart" | "newLines">[],
  file: string,
  line: number,
): boolean {
  return hunks.some(
    (h) =>
      h.file === file &&
      h.newLines > 0 &&
      line >= h.newStart &&
      line < h.newStart + h.newLines,
  );
}

/** One hunk's content shown to Claude, at most: a huge new file is cut short. */
const HUNK_MAX = 6_000;

/**
 * The hunks for a prompt. Every hunk is listed by id, path and range, so
 * Claude can place each one; content is shown until the budget runs out,
 * and after that a hunk is a header with a pointer to the file.
 */
export function hunkText(hunks: Hunk[], maxChars = 60_000): string {
  let used = 0;
  return hunks
    .map((h) => {
      const header = `${h.id}  ${h.file}  old ${h.oldStart},${h.oldLines}  new ${h.newStart},${h.newLines}`;
      let body = h.text.join("\n");
      if (body.length > HUNK_MAX) {
        body = `${body.slice(0, HUNK_MAX)}\n(… ${h.text.length} lines in all; read the file for the rest)`;
      }
      if (used + body.length > maxChars) return `${header}\n(content not shown here: read the file at these lines)`;
      used += body.length;
      return `${header}\n${body}`;
    })
    .join("\n\n");
}
