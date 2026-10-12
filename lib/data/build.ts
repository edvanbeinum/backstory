import { readModelAt } from "../model";
import { diffModels } from "./diff";
import { DATA_READERS, readDataModel } from "./readers";
import type { DataResponse } from "./types";

/**
 * Reads the data model at both ends of a view, with the first reader in
 * `DATA_READERS` that finds one at the head, and diffs it.
 */

/** What a view with no data model answers */
export const noDataModel = (): DataResponse => ({
  status: "none",
  readers: DATA_READERS.map((r) => r.label),
  baseModel: false,
  entities: [],
});

/** The data model's change for a view: which entities changed, and how. */
export async function buildData(
  root: string,
  base: string | null,
  head: string,
): Promise<DataResponse> {
  const after = await readDataModel(root, head);
  if (!after) return noDataModel();
  const before = base ? await readDataModel(root, base) : null;
  const entities = diffModels(before?.model ?? null, after.model);

  const c4 = (await readModelAt(root, head))?.model;
  for (const e of entities) {
    const ids = e.file && c4 ? c4.match(e.file) : [];
    e.component =
      ids.length === 1 ? (c4?.elements.get(ids[0])?.name ?? null) : null;
  }
  return {
    status: "ok",
    source: after.model.source,
    label: after.reader.label,
    readers: DATA_READERS.map((r) => r.label),
    baseModel: before !== null,
    entities,
  };
}
