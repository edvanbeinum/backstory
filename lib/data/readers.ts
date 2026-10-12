import { gitTry } from "../exec";
import { showFile } from "../model";
import { coreDataReader } from "./coredata";
import { railsReader } from "./rails";
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
  /** Every tracked path at the rev, listed once however many readers ask */
  listing(): Promise<string[]>;
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

export const DATA_READERS: DataReader[] = [railsReader, coreDataReader];

export function revFiles(root: string, rev: string): RevFiles {
  let listed: Promise<string[]> | null = null;
  return {
    root,
    rev,
    listing: () =>
      (listed ??= gitTry(root, ["ls-tree", "-r", "-z", "--name-only", rev], {
        maxBuffer: 256 * 1024 * 1024,
      }).then((out) => (out ?? "").split("\0").filter(Boolean))),
    show: (path) => showFile(root, rev, path),
  };
}

/** The data model at a rev from the first reader that finds one, and that reader. */
export async function readDataModel(
  root: string,
  rev: string,
): Promise<{ model: DataModel; reader: DataReader } | null> {
  const at = revFiles(root, rev);
  for (const reader of DATA_READERS) {
    const model = await reader.read(at);
    if (model) return { model, reader };
  }
  return null;
}
