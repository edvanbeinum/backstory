import type { ProviderGap } from "../ai/provider";

/** A place to look first, as the provider named it */
export interface LookFirst {
  name: string;
  reason: string;
  /** Whether the name is a component on the view's map, so it can outline it */
  onMap: boolean;
}

/** What a change does, why, and where to look first, in a few plain sentences */
export interface ChangeDescription {
  what: string;
  /** Null when the commit messages and the PR don't say why */
  why: string | null;
  lookFirst: LookFirst[];
}

/** A view's description read, as Story shows it */
export type DescriptionStatus =
  /** Nothing read yet: the provider's name, and whether the repo reads as views open */
  | { status: "idle"; provider: string; auto: boolean }
  | { status: "running"; startedAt: number }
  | {
      status: "done";
      description: ChangeDescription;
      /** The provider's name, for the "Drawn by" mark */
      provider: string;
      model: string | null;
      readAt: number;
    }
  | { status: "failed"; error: string }
  | { status: "unavailable"; provider: string; reason: ProviderGap };

/** What `/api/description` answers: a view's status, or none for uncommitted work */
export type DescriptionResponse = DescriptionStatus | { status: "none" };

/** Whether opening a view starts its read: only when nothing is read and the repo reads automatically. */
export const startsByItself = (status: DescriptionResponse | null) =>
  status?.status === "idle" && status.auto;
