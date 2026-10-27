import type {
  Constraint,
  Diffed,
  EntityDiff,
  Field,
  Relationship,
} from "./types";

/**
 * What the data view says at each level of reveal. The comparison in
 * diff.ts is complete; this decides what's worth a reader's attention:
 *
 * - a link is said once, by its arrow: the foreign-key rule behind a
 *   belongs-to, and the has-many at its other end, are the same link again;
 * - timestamps are bookkeeping, and the columns and foreign key of a new
 *   or removed link are its plumbing: both wait for "details". On a link
 *   that stays, a change to them (a NOT NULL, a foreign key) is news;
 * - an entity whose only change is the far end of someone else's new link
 *   hasn't changed in any way a reader needs told.
 */

const TIMESTAMPS = new Set([
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
]);

/**
 * Whether the graph draws a relationship as an arrow. A contains is drawn
 * only to another entity in the model, so one whose value isn't stored as an
 * entity of its own, or is the record's own type, stays on the card's list.
 */
export const isArrow = (r: Relationship, owner: string, names: Set<string>) =>
  r.kind === "belongs to" ||
  r.kind === "many to many" ||
  (r.kind === "contains" &&
    r.target !== null &&
    r.target !== owner &&
    names.has(r.target));

export interface Presented {
  entity: EntityDiff;
  /** "same" when nothing but echoes of other entities' changes moved */
  state: EntityDiff["state"];
  /** One line for the card and the strip: "New · 3 fields", "1 relationship added" */
  summary: string;
  /** Level 3: the field changes worth reading */
  fields: Diffed<Field>[];
  /** Level 3: relationship changes no arrow already says */
  relationships: Diffed<Relationship>[];
  /** Level 4: rules, link columns, timestamps */
  details: {
    rules: Diffed<Constraint>[];
    linkFields: Diffed<Field>[];
    timestamps: Diffed<Field>[];
  };
}

const changed = <T>(list: Diffed<T>[]) =>
  list.filter((d) => d.state !== "same");

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "2 fields added, 1 removed, 1 changed": the noun goes with the first count. */
function tally(list: Diffed<unknown>[], word: string) {
  const counts = (["added", "removed", "changed"] as const)
    .map((state) => ({
      state,
      n: list.filter((d) => d.state === state).length,
    }))
    .filter((c) => c.n > 0);
  if (counts.length === 0) return null;
  return counts
    .map(({ state, n }, i) =>
      i === 0 ? `${plural(n, word)} ${state}` : `${n} ${state}`,
    )
    .join(", ");
}

export function present(entities: EntityDiff[]): Presented[] {
  const names = new Set(entities.map((e) => e.name));
  /** Does `other` hold a belongs-to that points back at `name`? */
  const pointsAt = (other: string, name: string) =>
    entities
      .find((e) => e.name === other)
      ?.relationships.some(
        (d) =>
          d.item.kind === "belongs to" &&
          (d.item.target === name || (d.item.candidates ?? []).includes(name)),
      ) ?? false;

  return entities.map((entity) => {
    const linkNames = new Set(
      entity.relationships.flatMap((d) => d.item.fields ?? []),
    );
    const fieldsOf = (pred: (f: Diffed<Field>) => boolean) =>
      entity.fields.filter(pred);
    const timestamps = fieldsOf((f) => TIMESTAMPS.has(f.item.name));
    // Only a new or removed link's columns are plumbing it already says.
    const newLinks = new Set(
      changed(entity.relationships).flatMap((d) => d.item.fields ?? []),
    );
    const linkFields = fieldsOf(
      (f) => linkNames.has(f.item.name) && newLinks.has(f.item.name),
    );
    const own = fieldsOf(
      (f) => !TIMESTAMPS.has(f.item.name) && !linkFields.includes(f),
    );

    const arrows = changed(entity.relationships).filter((d) =>
      isArrow(d.item, entity.name, names),
    );
    // A has-many or has-one is the far end of another entity's belongs-to.
    const listed = changed(entity.relationships).filter(
      (d) =>
        !isArrow(d.item, entity.name, names) &&
        !(d.item.target && pointsAt(d.item.target, entity.name)) &&
        !d.item.as,
    );
    const belongsFields = new Set(
      changed(entity.relationships)
        .filter((d) => d.item.kind === "belongs to")
        .flatMap((d) => d.item.fields ?? []),
    );
    const rules = changed(entity.constraints).filter(
      (d) =>
        !(
          d.item.kind === "foreign key" &&
          d.item.fields.every((f) => belongsFields.has(f))
        ),
    );

    const fieldChanges = changed(own);
    const worthTelling =
      fieldChanges.length + arrows.length + listed.length + rules.length > 0;
    const state =
      entity.state === "changed" &&
      !worthTelling &&
      changed(timestamps).length === 0
        ? "same"
        : entity.state;

    let summary: string;
    if (state === "added") {
      summary = ["New", own.length && plural(own.length, "field")]
        .filter(Boolean)
        .join(" · ");
    } else if (state === "removed") {
      summary = "Removed";
    } else if (state === "same") {
      summary = "Unchanged";
    } else {
      const parts = [
        tally(fieldChanges, "field"),
        tally([...arrows, ...listed], "relationship"),
      ].filter(Boolean) as string[];
      // A rule is detail, unless it's all that changed.
      summary = parts.length
        ? parts.join(", ")
        : (tally(rules, "rule") ?? tally(timestamps, "field") ?? "");
    }

    return {
      entity,
      state,
      summary,
      fields: fieldChanges,
      relationships: listed,
      details: {
        rules,
        linkFields: changed(linkFields),
        timestamps: changed(timestamps),
      },
    };
  });
}
