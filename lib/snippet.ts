import { parseUnifiedDiff } from "./diff";
import { git } from "./exec";
import { FULL_CONTEXT, getRangePatch } from "./git";
import { EMPTY_TREE } from "./git";
import { highlightFiles } from "./highlight";
import { langForPath } from "./lang";
import { showFile } from "./model";
import type { DiffFile, DiffLine } from "./types";

/**
 * A few lines around one line of a view, for a flow step's inline code:
 * coloured as the diff colours them when the change touched the file, and
 * plain when it didn't (most steps sit in code the change never touched).
 */

export interface Snippet {
  path: string;
  /** Index into `file.hunks[0].lines` of the asked-for line */
  target: number;
  file: DiffFile;
  /** The file has changes elsewhere in this view */
  changed: boolean;
}

export async function snippet(opts: {
  root: string;
  base: string | null;
  head: string;
  path: string;
  side: "old" | "new";
  line: number;
  context?: number;
}): Promise<Snippet | null> {
  const { root, base, head, path, side, line } = opts;
  const context = opts.context ?? 6;

  const from = base ?? EMPTY_TREE;
  // A renamed file needs both its names in the pathspec, or git reads it
  // as one file deleted and another added, every line changed.
  const names = [path, ...(await renamePartner(root, from, head, path))];
  const patch = await getRangePatch(root, from, head, {
    context: FULL_CONTEXT,
    pathspec: names,
  });
  let lines: DiffLine[] | null =
    parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? null;
  const changed = lines !== null;
  if (!lines) {
    const text = await showFile(
      root,
      side === "old" ? (base ?? head) : head,
      path,
    );
    if (text === null) return null;
    lines = text
      .replace(/\n$/, "")
      .split("\n")
      .map((content, i) => ({
        type: "context",
        oldNo: i + 1,
        newNo: i + 1,
        content,
      }));
  }

  const at = lines.findIndex(
    (l) => (side === "old" ? l.oldNo : l.newNo) === line,
  );
  if (at === -1) return null;
  const start = Math.max(0, at - context);
  const window = lines.slice(start, at + context + 1);

  const file: DiffFile = {
    oldPath: path,
    newPath: path,
    path,
    status: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [
      {
        header: "",
        oldStart: window.find((l) => l.oldNo)?.oldNo ?? 0,
        oldLines: 0,
        newStart: window.find((l) => l.newNo)?.newNo ?? 0,
        newLines: 0,
        lines: window,
      },
    ],
    lang: langForPath(path),
  };
  await highlightFiles([file]);
  return { path, target: at - start, file, changed };
}

/** The file's other name, if this view renamed it to or from `path`. */
async function renamePartner(
  root: string,
  from: string,
  head: string,
  path: string,
): Promise<string[]> {
  const { stdout } = await git(root, [
    "diff",
    "--name-status",
    "-M",
    "-z",
    "--diff-filter=R",
    from,
    head,
  ]);
  const parts = stdout.split("\0");
  // -z: "R087", old path, new path, repeated.
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [oldPath, newPath] = [parts[i + 1], parts[i + 2]];
    if (newPath === path) return [oldPath];
    if (oldPath === path) return [newPath];
  }
  return [];
}
