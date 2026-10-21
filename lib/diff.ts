import { langForPath } from "./lang";
import type { DiffFile, DiffHunk, DiffLine } from "./types";

/**
 * Undo git's C-style path quoting: `"src/caf\303\251.ts"` → `src/café.ts`.
 * git quotes a path whenever it contains a space, a quote, or (with the
 * default core.quotepath) a non-ASCII byte.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;

  const inner = raw.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }

    const next = inner[++i];
    switch (next) {
      case "n":
        bytes.push(0x0a);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case "a":
        bytes.push(0x07);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      default:
        if (next >= "0" && next <= "7") {
          // \NNN octal escape — always exactly three digits from git
          const octal = inner.slice(i, i + 3);
          bytes.push(parseInt(octal, 8));
          i += 2;
        } else {
          bytes.push(...Buffer.from(next ?? "", "utf8"));
        }
    }
  }

  return Buffer.from(bytes).toString("utf8");
}

/** Strip the `a/` or `b/` prefix git adds to diff paths. */
function stripPrefix(path: string): string | null {
  if (path === "/dev/null") return null;
  const unquoted = unquotePath(path);
  if (/^[ab]\//.test(unquoted)) return unquoted.slice(2);
  return unquoted;
}

/**
 * Best-effort split of `diff --git a/x b/y`. The `---`/`+++` lines are
 * authoritative and override this, but binary files have no such lines, so
 * this has to cope on its own.
 */
function parseDiffGitLine(rest: string): [string | null, string | null] {
  // Both quoted, or one quoted — find the boundary at `" "` or ` b/`
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest, 0);
    if (end !== -1) {
      const first = rest.slice(0, end + 1);
      const second = rest.slice(end + 2);
      return [stripPrefix(first), stripPrefix(second)];
    }
  }

  // The common case: identical paths, so the midpoint is exact.
  // `a/foo b/foo` → length is 2*n + 1 with the space at n.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const first = rest.slice(0, mid);
    const second = rest.slice(mid + 1);
    if (first.slice(2) === second.slice(2)) {
      return [stripPrefix(first), stripPrefix(second)];
    }
  }

  // Renames with spaces: fall back to the last ` b/` occurrence.
  const idx = rest.lastIndexOf(" b/");
  if (idx !== -1) {
    return [stripPrefix(rest.slice(0, idx)), stripPrefix(rest.slice(idx + 1))];
  }

  const parts = rest.split(" ");
  if (parts.length === 2) return [stripPrefix(parts[0]), stripPrefix(parts[1])];
  return [null, null];
}

function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

const HUNK_RE = /^@@+ (.+?) @@+(.*)$/;

/** Parse `-12,7 +12,9` (or the multi-parent `-1,2 -3,4 +5,6` of a combined diff). */
function parseHunkRanges(spec: string) {
  const old = spec.match(/-(\d+)(?:,(\d+))?/);
  const neu = spec.match(/\+(\d+)(?:,(\d+))?/);
  return {
    oldStart: old ? Number(old[1]) : 0,
    oldLines: old ? (old[2] === undefined ? 1 : Number(old[2])) : 0,
    newStart: neu ? Number(neu[1]) : 0,
    newLines: neu ? (neu[2] === undefined ? 1 : Number(neu[2])) : 0,
  };
}

function emptyFile(): DiffFile {
  return {
    oldPath: null,
    newPath: null,
    path: "",
    status: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    lang: null,
  };
}

function finalize(file: DiffFile): DiffFile {
  file.path = file.newPath ?? file.oldPath ?? "";

  if (file.status === "modified") {
    if (file.oldPath === null && file.newPath !== null) file.status = "added";
    else if (file.newPath === null && file.oldPath !== null)
      file.status = "deleted";
    else if (
      file.oldPath !== null &&
      file.newPath !== null &&
      file.oldPath !== file.newPath
    )
      file.status = "renamed";
  }

  file.lang = langForPath(file.path);
  return file;
}

export interface ParseOptions {
  /**
   * Stop keeping line content past this many lines in a single file. The file
   * still appears with its stats, flagged `truncated`, so a 40k-line generated
   * file can't lock up the browser.
   */
  maxLinesPerFile?: number;
}

/**
 * Parse a unified diff into structured files/hunks/lines.
 *
 * Handles: added, deleted, renamed, copied, mode-only and binary files;
 * quoted paths; `\ No newline at end of file`; and multiple files per patch.
 * Combined diffs (`diff --cc` from merge commits) are recognised and marked
 * binary-ish rather than mis-parsed — see getCommitDiff for how they're fed in.
 */
export function parseUnifiedDiff(
  patch: string,
  opts: ParseOptions = {},
): DiffFile[] {
  const maxLines = opts.maxLinesPerFile ?? 20_000;
  const files: DiffFile[] = [];

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let lineCount = 0;

  const pushHunk = () => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (file) files.push(finalize(file));
    file = null;
    lineCount = 0;
  };

  // Splitting on \n keeps \r for CRLF files, which is correct — that carriage
  // return is part of the line's content and shows up in the diff.
  //
  // Drop exactly one trailing newline first. Without this, the final "" that
  // split() produces is indistinguishable from a genuinely empty context line
  // and every file picks up a phantom blank line at the end of its last hunk.
  const lines = patch.replace(/\n$/, "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      pushFile();
      file = emptyFile();
      const [a, b] = parseDiffGitLine(line.slice("diff --git ".length));
      file.oldPath = a;
      file.newPath = b;
      continue;
    }

    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      pushFile();
      file = emptyFile();
      const path = line.slice(line.indexOf(" ", 5) + 1);
      file.oldPath = unquotePath(path);
      file.newPath = unquotePath(path);
      continue;
    }

    if (!file) continue;

    if (line.startsWith("@@")) {
      const m = line.match(HUNK_RE);
      if (m) {
        pushHunk();
        const ranges = parseHunkRanges(m[1]);
        hunk = {
          header: m[2].trim(),
          ...ranges,
          lines: [],
        };
        oldNo = ranges.oldStart;
        newNo = ranges.newStart;
        continue;
      }
    }

    if (hunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" — attach to the previous line
        const prev = hunk.lines[hunk.lines.length - 1];
        if (prev) prev.noNewline = true;
        continue;
      }

      const marker = line[0];
      if (marker === "+" || marker === "-" || marker === " " || line === "") {
        // A truly empty string here is a context line whose content is empty;
        // git emits " " but some tools trim trailing whitespace.
        const content = line === "" ? "" : line.slice(1);
        let entry: DiffLine;

        if (marker === "+") {
          entry = { type: "add", oldNo: null, newNo: newNo++, content };
          file.additions++;
        } else if (marker === "-") {
          entry = { type: "del", oldNo: oldNo++, newNo: null, content };
          file.deletions++;
        } else {
          entry = { type: "context", oldNo: oldNo++, newNo: newNo++, content };
        }

        if (lineCount < maxLines) {
          hunk.lines.push(entry);
        } else {
          file.truncated = true;
        }
        lineCount++;
        continue;
      }

      // Anything else ends the hunk (e.g. the next file's header lines)
      pushHunk();
    }

    if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      file.oldPath = p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      file.newPath = p;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length).trim();
      file.oldPath = null;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length).trim();
      file.newPath = null;
      continue;
    }
    if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length).trim();
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquotePath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquotePath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquotePath(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.newPath = unquotePath(line.slice("copy to ".length));
      continue;
    }
    if (line.startsWith("similarity index ")) {
      file.similarity = parseInt(line.slice("similarity index ".length), 10);
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      file.isBinary = true;
      continue;
    }
  }

  pushFile();
  return files;
}

/** Total +/- across a set of files, for the header summary. */
export function totals(files: DiffFile[]) {
  return files.reduce(
    (acc, f) => {
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}
