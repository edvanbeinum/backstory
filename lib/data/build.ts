import { readModelAt, type Model } from "../model";
import { autoRead, dataStatus, providerName, readDrafted } from "./cache";
import { diffModels } from "./diff";
import { DATA_READERS, dataSteer, readDataModel, steerError } from "./readers";
import type { DataResponse, EntityDiff } from "./types";

/**
 * Reads the data model at both ends of a view, with the first reader in
 * `DATA_READERS` that finds one at the head, and diffs it. When none does,
 * the AI provider's drafted model stands in, once it has been read: derived
 * from main's model, or read on a click.
 * `data.files` and `data.format` in the C4 model at the head steer both
 * ends.
 */

/** What a view with no data model answers */
export const noDataModel = (): DataResponse => ({
  status: "none",
  readers: DATA_READERS.map((r) => r.label),
  drafted: null,
  baseModel: false,
  entities: [],
});

function withComponents(
  c4: Model | null,
  entities: EntityDiff[],
): EntityDiff[] {
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
  const c4 = (await readModelAt(root, head))?.model ?? null;
  const steer = dataSteer(c4?.properties);
  const error = steerError(steer);
  if (error) return { ...noDataModel(), error };
  const after = await readDataModel(root, head, steer);
  if (!after) {
    const view = { root, base, head, files: steer.files };
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
      auto: autoRead(),
      baseModel: drafted.base !== null,
      entities: withComponents(
        c4,
        diffModels(drafted.base, drafted.head, { whole: true }),
      ),
    };
  }
  const before = base ? await readDataModel(root, base, steer) : null;
  return {
    ...noDataModel(),
    status: "ok",
    source: after.model.source,
    label: after.reader.label,
    baseModel: before !== null,
    entities: withComponents(
      c4,
      diffModels(before?.model ?? null, after.model),
    ),
  };
}
