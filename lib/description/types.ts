import type { ProviderGap } from "../ai/provider";
import type { MapResponse } from "../map";

/** A place to look first, as the provider named it */
interface LookFirst {
  name: string;
  reason: string;
}

/**
 * Whether a place to look first is a component on the map, matched exactly,
 * so it can outline it. Checked against the map on screen rather than when
 * the description is read, so a map drawn after it still links.
 */
export const isOnMap = (name: string, map: MapResponse | null) =>
  map?.status === "ok" && map.nodes.some((n) => n.name === name);

/** One sentence on what the change does in a component, by its name on the map */
interface ComponentSentence {
  name: string;
  sentence: string;
}

/** What a change does, why, and where to look first, in a few plain sentences */
export interface ChangeDescription {
  what: string;
  /** Null when the commit messages and the PR don't say why */
  why: string | null;
  lookFirst: LookFirst[];
  components: ComponentSentence[];
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
      /** Whether the repo reads as views open, for its switch */
      auto: boolean;
      /** Why the last Describe again failed, when it did */
      error?: string;
      /** Why the last Describe again couldn't start, when the provider is missing or signed out */
      gap?: ProviderGap;
    }
  | { status: "failed"; error: string }
  | { status: "unavailable"; provider: string; reason: ProviderGap };

/** What `/api/description` answers: a view's status, or none for uncommitted work */
export type DescriptionResponse = DescriptionStatus | { status: "none" };

/** Whether opening a view starts its read: only when nothing is read and the repo reads automatically. */
export const startsByItself = (status: DescriptionResponse | null) =>
  status?.status === "idle" && status.auto;
