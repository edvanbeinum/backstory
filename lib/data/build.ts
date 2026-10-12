import { readModelAt } from "../model";
import { dataStatus, providerName, readDrafted } from "./cache";
import { diffModels } from "./diff";
import { DATA_READERS, readDataModel } from "./readers";
import type { DataResponse, EntityDiff } from "./types";

/**
 * Reads the data model at both ends of a view, with the first reader in
 * `DATA_READERS` that finds one at the head, and diffs it. When none does,
 * the AI provider's drafted model stands in, once a click has read it.
 */

/** What a view with no data model answers */
export const noDataModel = (): DataResponse => ({
  status: "none",
  readers: DATA_READERS.map((r) => r.label),
  drafted: null,
  baseModel: false,
  entities: [],
});

async function withComponents(
  root: string,
  head: string,
  entities: EntityDiff[],
): Promise<EntityDiff[]> {
  const c4 = (await readModelAt(root, head))?.model;
  for (const e of entities) {
    const ids = e.file && c4 ? c4.match(e.file) : [];
    e.component =
      ids.length === 1 ? (c4?.elements.get(ids[0])?.name ?? null) : null;
  }
  return entities;
}

/** The data model's change for a view: which entities changed, and how. */
export async function buildData(
  root: string,
  base: string | null,
  head: string,
): Promise<DataResponse> {
  const after = await readDataModel(root, head);
  if (!after) {
    const view = { root, base, head };
    const draft = await dataStatus(view);
    const drafted = await readDrafted(view);
    if (!drafted) return { ...noDataModel(), draft };
    return {
      ...noDataModel(),
      status: "ok",
      source: "drafted",
      drafted: {
        provider: providerName(drafted.provider),
        model: drafted.model,
      },
      draft,
      baseModel: drafted.base !== null,
      entities: await withComponents(
        root,
        head,
        diffModels(drafted.base, drafted.head),
      ),
    };
  }
  const before = base ? await readDataModel(root, base) : null;
  return {
    ...noDataModel(),
    status: "ok",
    source: after.model.source,
    label: after.reader.label,
    baseModel: before !== null,
    entities: await withComponents(
      root,
      head,
      diffModels(before?.model ?? null, after.model),
    ),
  };
}
