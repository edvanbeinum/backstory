/**
 * A repo's data model in one shape, whatever wrote it down: Rails's
 * schema.rb and models, a Core Data model, SQL schema files. The data view
 * draws and compares this, never the source format.
 */

export interface Field {
  name: string;
  /** The stack's own type name, e.g. "string", "integer 64" */
  type: string;
  required: boolean;
  /** An enum's values, in order */
  values?: string[];
}

export type RelationshipKind =
  "belongs to" | "has many" | "has one" | "many to many";

export interface Relationship {
  name: string;
  kind: RelationshipKind;
  /** The entity it points at; null when polymorphic (any of several) */
  target: string | null;
  polymorphic: boolean;
  /**
   * For a polymorphic belongs-to, the entities that declare themselves one
   * of its kinds (`has_one :item, as: :source`): what "any" means today.
   */
  candidates?: string[];
  /** For a has-one or has-many, the polymorphic relationship it fills (`as: :source`) */
  as?: string;
  /** For a has-many through another relationship */
  through?: string;
  /** The entity's own columns that hold this link, e.g. source_type, source_id */
  fields?: string[];
}

export interface Constraint {
  kind: "unique" | "foreign key";
  fields: string[];
  /** For a foreign key, the entity it points at */
  target?: string;
}

export interface Entity {
  name: string;
  /** Where it's declared, for its component and for opening its code */
  file: string | null;
  fields: Field[];
  relationships: Relationship[];
  constraints: Constraint[];
}

/** A data reader's format */
export type DataSource = "rails" | "core data" | "sql";

export interface DataModel {
  /** Which reader produced it, or "drafted" for the AI provider's reading */
  source: DataSource | "drafted";
  entities: Map<string, Entity>;
}

export type ChangeState = "added" | "removed" | "changed" | "same";

export interface Diffed<T> {
  state: ChangeState;
  item: T;
  /** For a changed item, what it was */
  before?: T;
}

export interface EntityDiff {
  name: string;
  state: ChangeState;
  file: string | null;
  /** The C4 component its file belongs to, when the repo has a model */
  component: string | null;
  fields: Diffed<Field>[];
  relationships: Diffed<Relationship>[];
  constraints: Diffed<Constraint>[];
}

export interface DataResponse {
  status: "ok" | "none";
  source?: DataModel["source"];
  /** Where the model was read from, the reader's label, for the overlay's footnote */
  label?: string;
  /** Every reader's label, in order, for the empty state */
  readers: string[];
  /** False when the base has no data model: everything reads as added */
  baseModel: boolean;
  /** Entities the change touched, then their unchanged neighbours */
  entities: EntityDiff[];
  /** Who drafted the model, when no reader found one and the AI provider read it */
  drafted: { provider: string; model: string | null } | null;
  /** When no reader found a model: the AI provider's read, for this view */
  draft?: DataDraftStatus;
  /** Why no reader was tried: a `data.format` Backstory doesn't read */
  error?: string;
}

/** A drafted data model's read for one view, as the data strip shows it */
export type DataDraftStatus =
  /** Nothing read yet: the provider's name, for the offer's copy */
  | { status: "idle"; provider: string }
  | { status: "running"; phase: string; startedAt: number }
  | { status: "done"; costUsd: number; durationMs: number }
  | { status: "failed"; error: string }
  /** The provider isn't ready: its name and what to do about it */
  | { status: "unavailable"; provider: string; setup: string };
