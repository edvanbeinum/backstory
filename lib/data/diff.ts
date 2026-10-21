import type {
  ChangeState,
  Constraint,
  DataModel,
  Diffed,
  Entity,
  EntityDiff,
  Field,
  Relationship,
} from "./types";

/**
 * Two data models compared entity by entity, and within an entity field by
 * field, relationship by relationship and constraint by constraint, each
 * matched by its name (a constraint by what it constrains).
 */

function diffBy<T>(
  before: T[],
  after: T[],
  key: (t: T) => string,
  same: (a: T, b: T) => boolean,
): Diffed<T>[] {
  const old = new Map(before.map((t) => [key(t), t]));
  const out: Diffed<T>[] = [];
  for (const item of after) {
    const prior = old.get(key(item));
    if (!prior) out.push({ state: "added", item });
    else if (!same(prior, item))
      out.push({ state: "changed", item, before: prior });
    else out.push({ state: "same", item });
  }
  const now = new Set(after.map(key));
  for (const item of before)
    if (!now.has(key(item))) out.push({ state: "removed", item });
  return out;
}

const fieldSame = (a: Field, b: Field) =>
  a.type === b.type &&
  a.required === b.required &&
  (a.values ?? []).join() === (b.values ?? []).join();
const relSame = (a: Relationship, b: Relationship) =>
  a.kind === b.kind &&
  a.target === b.target &&
  a.polymorphic === b.polymorphic &&
  a.through === b.through &&
  (a.candidates ?? []).join() === (b.candidates ?? []).join();
// A unique rule's columns are a set, so reordering them changes no rule; a
// foreign key's order pairs each column with the target's, so it stays.
const constraintKey = (c: Constraint) =>
  `${c.kind}:${(c.kind === "unique" ? [...c.fields].sort() : c.fields).join(",")}:${c.target ?? ""}`;

function diffEntity(
  name: string,
  before: Entity | undefined,
  after: Entity | undefined,
): EntityDiff {
  const b = before ?? {
    name,
    file: null,
    fields: [],
    relationships: [],
    constraints: [],
  };
  const a = after ?? {
    name,
    file: null,
    fields: [],
    relationships: [],
    constraints: [],
  };
  const fields = diffBy(b.fields, a.fields, (f) => f.name, fieldSame);
  const relationships = diffBy(
    b.relationships,
    a.relationships,
    (r) => r.name,
    relSame,
  );
  const constraints = diffBy(
    b.constraints,
    a.constraints,
    constraintKey,
    () => true,
  );
  const moved = [...fields, ...relationships, ...constraints].some(
    (d) => d.state !== "same",
  );
  const state: ChangeState = !before
    ? "added"
    : !after
      ? "removed"
      : moved
        ? "changed"
        : "same";
  return {
    name,
    state,
    file: a.file ?? b.file,
    component: null,
    fields,
    relationships,
    constraints,
  };
}

/** Neighbours shown with the changed entities: at most this many. */
const MAX_NEIGHBOURS = 6;

/** `whole`: when nothing changed, every entity, unchanged, so the model can still be looked at. */
export function diffModels(
  base: DataModel | null,
  head: DataModel,
  opts: { whole?: boolean } = {},
): EntityDiff[] {
  const names = new Set([
    ...head.entities.keys(),
    ...(base?.entities.keys() ?? []),
  ]);
  const all = [...names].map((n) =>
    diffEntity(
      n,
      base ? base.entities.get(n) : head.entities.get(n),
      head.entities.get(n),
    ),
  );
  // Without a base model nothing can be said to have changed; show none
  // rather than everything as new.
  const changed = base ? all.filter((e) => e.state !== "same") : [];
  if (opts.whole && changed.length === 0)
    return [...head.entities.values()].map((e) => diffEntity(e.name, e, e));
  const touched = new Set(changed.map((e) => e.name));

  // The unchanged entities they relate to, either way round.
  const score = new Map<string, number>();
  for (const e of all) {
    for (const r of e.relationships) {
      const target = r.item.target;
      if (!target) continue;
      if (touched.has(e.name) && !touched.has(target))
        score.set(target, (score.get(target) ?? 0) + 1);
      if (touched.has(target) && !touched.has(e.name))
        score.set(e.name, (score.get(e.name) ?? 0) + 1);
    }
  }
  const neighbours = [...score]
    .sort((x, y) => y[1] - x[1])
    .slice(0, MAX_NEIGHBOURS)
    .map(([n]) => all.find((e) => e.name === n))
    .filter((e): e is EntityDiff => Boolean(e));

  const rank: Record<ChangeState, number> = {
    added: 0,
    changed: 1,
    removed: 2,
    same: 3,
  };
  return [
    ...changed.sort((x, y) => rank[x.state] - rank[y.state]),
    ...neighbours,
  ];
}
