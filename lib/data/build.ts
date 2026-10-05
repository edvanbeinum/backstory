import { gitTry } from "../exec";
import { readModelAt, showFile } from "../model";
import { readCoreData } from "./coredata";
import { diffModels } from "./diff";
import { readRails } from "./rails";
import type { DataModel, DataResponse } from "./types";

/**
 * Reads the data model (Rails schema and models, or Core Data) at both ends
 * of a view and diffs it.
 *
 * Files are read one by one rather than in one batch, because git's batch
 * output gives sizes in bytes and the text is sliced in characters.
 */

/**
 * Every model file at a commit. Read one by one, a few at a time: git's
 * batch output gives sizes in bytes, and slicing decoded text by them
 * goes wrong at the first non-ASCII character.
 */
async function readFiles(
  root: string,
  rev: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const text = await showFile(root, rev, path);
      if (text !== null) out.set(path, text);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

async function readDataModel(
  root: string,
  rev: string,
): Promise<DataModel | null> {
  const schema = await showFile(root, rev, "db/schema.rb");
  if (schema) {
    const listing =
      (await gitTry(root, [
        "ls-tree",
        "-r",
        "--name-only",
        rev,
        "app/models",
      ])) ?? "";
    const paths = listing.split("\n").filter((p) => p.endsWith(".rb"));
    return readRails({ schema, models: await readFiles(root, rev, paths) });
  }

  const listing =
    (await gitTry(root, ["ls-tree", "-r", "--name-only", rev])) ?? "";
  const bundles = [
    ...new Set(
      listing
        .split("\n")
        .map((p) => p.match(/^(.*\.xcdatamodeld)\//)?.[1])
        .filter(Boolean),
    ),
  ] as string[];
  for (const bundle of bundles) {
    const current = await showFile(root, rev, `${bundle}/.xccurrentversion`);
    const version =
      current?.match(
        /<key>_XCCurrentVersionName<\/key>\s*<string>([^<]+)<\/string>/,
      )?.[1] ??
      listing
        .split("\n")
        .find((p) => p.startsWith(`${bundle}/`) && p.endsWith("/contents"))
        ?.split("/")
        .at(-2);
    if (!version) continue;
    const path = `${bundle}/${version}/contents`;
    const xml = await showFile(root, rev, path);
    if (xml) return readCoreData(xml, path);
  }
  return null;
}

/** The data model's change for a view: which entities changed, and how. */
export async function buildData(
  root: string,
  base: string | null,
  head: string,
): Promise<DataResponse> {
  const after = await readDataModel(root, head);
  if (!after) return { status: "none", baseModel: false, entities: [] };
  const before = base ? await readDataModel(root, base) : null;
  const entities = diffModels(before, after);

  const c4 = (await readModelAt(root, head))?.model;
  for (const e of entities) {
    const ids = e.file && c4 ? c4.match(e.file) : [];
    e.component =
      ids.length === 1 ? (c4?.elements.get(ids[0])?.name ?? null) : null;
  }
  return {
    status: "ok",
    source: after.source,
    baseModel: before !== null,
    entities,
  };
}
