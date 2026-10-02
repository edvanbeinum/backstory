import { gitTry, run } from "../exec";
import { readModelAt, showFile } from "../model";
import { readCoreData } from "./coredata";
import { diffModels } from "./diff";
import { readRails } from "./rails";
import type { DataModel, DataResponse } from "./types";

/** Every model file at a commit, read in one `git cat-file --batch`. */
async function readFiles(root: string, rev: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const { stdout } = await run("git", ["cat-file", "--batch"], {
    cwd: root,
    input: paths.map((p) => `${rev}:${p}`).join("\n") + "\n",
    maxBuffer: 128 * 1024 * 1024,
  });
  let at = 0;
  for (const path of paths) {
    const header = stdout.slice(at, stdout.indexOf("\n", at));
    at += header.length + 1;
    const size = Number(header.split(" ")[2]);
    if (Number.isNaN(size)) continue; // "missing"
    out.set(path, stdout.slice(at, at + size));
    at += size + 1;
  }
  return out;
}

async function readDataModel(root: string, rev: string): Promise<DataModel | null> {
  const schema = await showFile(root, rev, "db/schema.rb");
  if (schema) {
    const listing = (await gitTry(root, ["ls-tree", "-r", "--name-only", rev, "app/models"])) ?? "";
    const paths = listing.split("\n").filter((p) => p.endsWith(".rb"));
    return readRails({ schema, models: await readFiles(root, rev, paths) });
  }

  const listing = (await gitTry(root, ["ls-tree", "-r", "--name-only", rev])) ?? "";
  const bundles = [...new Set(listing.split("\n").map((p) => p.match(/^(.*\.xcdatamodeld)\//)?.[1]).filter(Boolean))] as string[];
  for (const bundle of bundles) {
    const current = await showFile(root, rev, `${bundle}/.xccurrentversion`);
    const version =
      current?.match(/<key>_XCCurrentVersionName<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ??
      listing.split("\n").find((p) => p.startsWith(`${bundle}/`) && p.endsWith("/contents"))?.split("/").at(-2);
    if (!version) continue;
    const path = `${bundle}/${version}/contents`;
    const xml = await showFile(root, rev, path);
    if (xml) return readCoreData(xml, path);
  }
  return null;
}

/** The data model's change for a view: which entities changed, and how. */
export async function buildData(root: string, base: string | null, head: string): Promise<DataResponse> {
  const after = await readDataModel(root, head);
  if (!after) return { status: "none", baseModel: false, entities: [] };
  const before = base ? await readDataModel(root, base) : null;
  const entities = diffModels(before, after);

  const c4 = (await readModelAt(root, head))?.model;
  for (const e of entities) {
    const ids = e.file && c4 ? c4.match(e.file) : [];
    e.component = ids.length === 1 ? (c4?.elements.get(ids[0])?.name ?? null) : null;
  }
  return { status: "ok", source: after.source, baseModel: before !== null, entities };
}
