import { createHash } from "node:crypto";

import { gitTry } from "../exec";
import { readModelAt, type Model } from "../model";
import type { FlowSet } from "./types";

/**
 * Each lane's C4 component, worked out when the flows are shown rather than
 * when they're traced, so flows traced before a model existed pick one up,
 * and editing the model updates them without tracing again.
 *
 * A lane's component is where its code lives: first the files of the calls
 * it makes, then, for a type that's only ever called, the file defining it.
 */

const cache = ((
  globalThis as {
    __differLaneComponents?: Map<string, Map<string, string | null>>;
  }
).__differLaneComponents ??= new Map());

/** Bumped when the lookup changes, so a running server drops old answers. */
const LOOKUP_VERSION = "3";

/** The type's own name: `Native::InitialLibrary` is defined as `InitialLibrary`. */
const shortName = (name: string) => name.split(/::|\./).pop() ?? name;

async function definedIn(
  root: string,
  head: string,
  name: string,
): Promise<string[]> {
  const short = shortName(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(short)) return [];
  const out = await gitTry(root, [
    "grep",
    "-l",
    "-E",
    // POSIX classes: git grep -E has no \s or \b. A Ruby class may be
    // declared by its qualified name, `class ContainerPolicy::PlaybackScope`.
    `^[[:space:]]*((final|public|private|internal|open|export|abstract|default)[[:space:]]+)*(class|struct|enum|protocol|actor|module|interface|type|function|const)[[:space:]]+([A-Za-z0-9_]+(::|\\.))*${short}([^A-Za-z0-9_]|$)`,
    head,
  ]);
  return (out ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(head.length + 1));
}

const snake = (name: string) =>
  name
    .split("::")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/");

/**
 * Of the files that define a type, the one where it lives: Rails keeps
 * `Native::InitialLibrary` in `native/initial_library.rb` and Swift keeps
 * `Foo` in `Foo.swift`. An admin resource also called `User` is not it.
 */
function bestDefinition(name: string, files: string[]): string | null {
  const conventional = [
    `/${snake(name)}.rb`,
    `/${shortName(name)}.swift`,
    `/${shortName(name)}.ts`,
  ];
  const score = (f: string) =>
    (conventional.some((c) => `/${f}`.endsWith(c)) ? 100 : 0) -
    f.split("/").length;
  return [...files].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function vote(model: Model, files: string[]): string | null {
  const votes = new Map<string, number>();
  for (const f of files) {
    const ids = model.match(f);
    if (ids.length === 1) votes.set(ids[0], (votes.get(ids[0]) ?? 0) + 1);
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? (model.elements.get(best)?.name ?? best) : null;
}

export async function attachComponents(
  root: string,
  set: FlowSet,
): Promise<FlowSet> {
  const model = (await readModelAt(root, set.head))?.model;
  if (!model) return set;

  // Keyed on everything the answer depends on: the lanes (a traced hunk
  // adds new ones) and each element's name and globs (the model can change).
  const lanes = [
    ...new Set(set.flows.flatMap((f) => f.participants.map((p) => p.name))),
  ].sort();
  const signature = createHash("sha1")
    .update(LOOKUP_VERSION)
    .update(set.head)
    .update(JSON.stringify(lanes))
    .update(
      JSON.stringify(
        [...model.elements.values()].map((e) => [e.id, e.name, e.globs]),
      ),
    )
    .digest("hex");
  let components = cache.get(signature);
  if (!components) {
    components = new Map();
    const lanes = new Map<string, { external: boolean; calls: string[] }>();
    for (const flow of set.flows) {
      for (const p of flow.participants) {
        const lane = lanes.get(p.name) ?? { external: p.external, calls: [] };
        lanes.set(p.name, lane);
      }
      for (const s of flow.after) lanes.get(s.from)?.calls.push(s.file);
    }
    for (const [name, lane] of lanes) {
      if (lane.external) {
        components.set(name, null);
        continue;
      }
      const fromCalls = vote(model, lane.calls);
      const home = fromCalls
        ? null
        : bestDefinition(name, await definedIn(root, set.head, name));
      components.set(name, fromCalls ?? (home ? vote(model, [home]) : null));
    }
    cache.set(signature, components);
  }

  const resolved = components;
  return {
    ...set,
    flows: set.flows.map((f) => ({
      ...f,
      participants: f.participants.map((p) => ({
        ...p,
        component: resolved.get(p.name) ?? null,
      })),
    })),
  };
}
