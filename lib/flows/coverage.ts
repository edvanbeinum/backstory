import type { DiffFile } from "../types";
import type { FlowHunk, FlowSet } from "./types";

/**
 * Which of the diff's hunks sit on a flow. Counted in the hunks the diff
 * view shows (3 lines of context), so the number matches what's on screen;
 * a view hunk is on a flow when one of its changed lines falls in a
 * zero-context hunk that Claude placed on a flow.
 */

export interface ViewHunk {
  file: string;
  /** The first changed line, for jumping to it */
  line: number;
  side: "old" | "new";
  onFlow: boolean;
  /** The zero-context hunks inside it that are on no flow */
  offFlow: FlowHunk[];
}

export function coverage(set: FlowSet, files: DiffFile[]): ViewHunk[] {
  const app = new Set(set.appFiles);
  const out: ViewHunk[] = [];
  for (const file of files) {
    if (!app.has(file.path)) continue;
    const zero = set.hunks.filter((h) => h.file === file.path);
    for (const hunk of file.hunks) {
      const added = hunk.lines
        .filter((l) => l.type === "add")
        .map((l) => l.newNo!);
      const removed = hunk.lines
        .filter((l) => l.type === "del")
        .map((l) => l.oldNo!);
      if (added.length === 0 && removed.length === 0) continue;
      const inside = zero.filter(
        (z) =>
          added.some((n) => n >= z.newStart && n < z.newStart + z.newLines) ||
          removed.some((n) => n >= z.oldStart && n < z.oldStart + z.oldLines),
      );
      out.push({
        file: file.path,
        line: added[0] ?? removed[0],
        side: added.length > 0 ? "new" : "old",
        onFlow: inside.some((z) => z.flows.length > 0),
        offFlow: inside.filter((z) => z.flows.length === 0),
      });
    }
  }
  return out;
}
