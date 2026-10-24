import picomatch from "picomatch";

import { gitTry } from "../exec";
import { showFile, splitGlobs } from "../model";
import { coreDataReader } from "./coredata";
import { railsReader } from "./rails";
import { sqlReader } from "./sql";
import type { DataModel, DataSource } from "./types";

/**
 * The formats Backstory reads a data model from, in order: the first that
 * finds one at a commit wins. Adding a format is a file in `lib/data/` and a
 * line in `DATA_READERS`.
 */

/** One commit's files, for a reader to look through. */
export interface RevFiles {
  root: string;
  rev: string;
  /**
   * Every tracked path at the rev, listed once however many readers ask;
   * only those matching `data.files` when it's set
   */
  listing(): Promise<string[]>;
  /** True when `data.files` chose the listing: a reader looks only there, not at its usual paths */
  steered: boolean;
  /** One file's text, or null when it isn't there */
  show(path: string): Promise<string | null>;
}

export interface DataReader {
  source: DataSource;
  /** For the empty state and the overlay's footnote, e.g. "db/schema.rb and the models" */
  label: string;
  /** Reads the model at the rev, or null when the format isn't there */
  read(at: RevFiles): Promise<DataModel | null>;
}

export const DATA_READERS: DataReader[] = [
  railsReader,
  coreDataReader,
  sqlReader,
];

/** Data steering: `data.files` and `data.format` from the workspace's properties. */
interface DataSteer {
  /** Globs for the files that hold the data model */
  files: string[] | null;
  /** The one reader's `source` to try */
  format: string | null;
}

export function dataSteer(
  properties: Record<string, string> | undefined,
): DataSteer {
  const files = splitGlobs(properties?.["data.files"]);
  return {
    files: files.length > 0 ? files : null,
    format: properties?.["data.format"]?.trim() || null,
  };
}

/** What's wrong with the steer, or null: a `data.format` no reader has. */
export function steerError(steer: DataSteer): string | null {
  if (!steer.format || DATA_READERS.some((r) => r.source === steer.format))
    return null;
  const known = DATA_READERS.map((r) => r.source);
  return `data.format says "${steer.format}"; Backstory reads ${known.slice(0, -1).join(", ")} and ${known.at(-1)}`;
}

function revFiles(
  root: string,
  rev: string,
  files: string[] | null = null,
): RevFiles {
  const wanted = files ? picomatch(files, { dot: true }) : null;
  let listed: Promise<string[]> | null = null;
  return {
    root,
    rev,
    steered: wanted !== null,
    listing: () =>
      (listed ??= gitTry(root, ["ls-tree", "-r", "-z", "--name-only", rev], {
        maxBuffer: 256 * 1024 * 1024,
      }).then((out) =>
        (out ?? "").split("\0").filter((p) => p && (!wanted || wanted(p))),
      )),
    show: (path) => showFile(root, rev, path),
  };
}

/**
 * The data model at a rev from the first reader that finds one, and that
 * reader. The steer comes from the view's head and is used at both ends, so
 * a commit that adds it doesn't read its base some other way.
 */
export async function readDataModel(
  root: string,
  rev: string,
  steer: DataSteer,
): Promise<{ model: DataModel; reader: DataReader } | null> {
  const at = revFiles(root, rev, steer.files);
  for (const reader of DATA_READERS) {
    if (steer.format && reader.source !== steer.format) continue;
    const model = await reader.read(at);
    if (model) return { model, reader };
  }
  return null;
}
