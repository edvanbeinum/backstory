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

const isArrow = (r: Relationship) =>
  r.kind === "belongs to" || r.kind === "many to many" || r.kind === "contains";

export interface Presented {
  entity: EntityDiff;
  /** "same" when nothing but echoes of other entities' changes moved */
  state: EntityDiff["state"];
  /** One line for the card and the strip: "New · 3 fields", "+1 relationship" */
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

function tally(list: Diffed<unknown>[], word: string) {
  const added = list.filter((d) => d.state === "added").length;
  const removed = list.filter((d) => d.state === "removed").length;
  const moved = list.filter((d) => d.state === "changed").length;
  const total = added + removed + moved;
  if (!total) return null;
  const bits = [
    added && `+${added}`,
    removed && `−${removed}`,
    moved && `~${moved}`,
  ].filter(Boolean);
  return `${bits.join(" ")} ${word}${total === 1 ? "" : "s"}`;
}

export function present(entities: EntityDiff[]): Presented[] {
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

    const arrows = changed(entity.relationships).filter((d) => isArrow(d.item));
    // A has-many or has-one is the far end of another entity's belongs-to.
    const listed = changed(entity.relationships).filter(
      (d) =>
        !isArrow(d.item) &&
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
