import type { DataReader } from "./readers";
import type {
  Constraint,
  DataModel,
  Entity,
  Field,
  Relationship,
} from "./types";

/**
 * A Core Data model: the current version's `contents` XML inside an
 * `.xcdatamodeld` bundle. Read as text, attribute by attribute.
 */

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;

export function readCoreData(xml: string, file: string): DataModel {
  const entities = new Map<string, Entity>();
  for (const block of xml.split(/<entity\b/).slice(1)) {
    const open = block.slice(0, block.indexOf(">"));
    const name = attr(open, "name");
    if (!name) continue;
    const body = block.slice(0, block.indexOf("</entity>"));

    const fields: Field[] = [...body.matchAll(/<attribute\b[^>]*>/g)].map(
      ([tag]) => ({
        name: attr(tag, "name") ?? "?",
        type: (attr(tag, "attributeType") ?? "?").toLowerCase(),
        required: attr(tag, "optional") !== "YES",
      }),
    );
    const relationships: Relationship[] = [
      ...body.matchAll(/<relationship\b[^>]*>/g),
    ].map(([tag]) => ({
      name: attr(tag, "name") ?? "?",
      kind: attr(tag, "toMany") === "YES" ? "has many" : "belongs to",
      target: attr(tag, "destinationEntity"),
      polymorphic: false,
    }));
    const constraints: Constraint[] = [
      ...body.matchAll(
        /<uniquenessConstraint>([\s\S]*?)<\/uniquenessConstraint>/g,
      ),
    ].map(([, inner]) => ({
      kind: "unique" as const,
      fields: [...inner.matchAll(/<constraint value="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    }));
    entities.set(name, { name, file, fields, relationships, constraints });
  }
  return { source: "core data", entities };
}

export const coreDataReader: DataReader = {
  source: "core data",
  label: "a Core Data model",
  async read(at) {
    const listing = await at.listing();
    const bundles = [
      ...new Set(
        listing
          .map((p) => p.match(/^(.*\.xcdatamodeld)\//)?.[1])
          .filter(Boolean),
      ),
    ] as string[];
    for (const bundle of bundles) {
      const current = await at.show(`${bundle}/.xccurrentversion`);
      const version =
        current?.match(
          /<key>_XCCurrentVersionName<\/key>\s*<string>([^<]+)<\/string>/,
        )?.[1] ??
        listing
          .find((p) => p.startsWith(`${bundle}/`) && p.endsWith("/contents"))
          ?.split("/")
          .at(-2);
      if (!version) continue;
      const path = `${bundle}/${version}/contents`;
      const xml = await at.show(path);
      if (xml) return readCoreData(xml, path);
    }
    return null;
  },
};
