import { claudeCode } from "./claude";

/**
 * The one place Backstory picks the tool it asks to read code: flows, the
 * map's draft and the drafted data model all run through `aiProvider()`.
 * A provider must be an agent that reads a directory itself, not a chat API;
 * one that can't would need a read-only tool loop of Backstory's own.
 */

/**
 * What every provider must do: read the files under cwd with read-only tools,
 * run nothing, load no settings from cwd, and answer in the JSON schema. cwd
 * holds a commit's tracked files only, and a provider must not assume it can
 * see anything outside it. Tests pass stand-ins with recorded answers.
 */
export type Runner = <T>(
  prompt: string,
  schema: object,
  cwd: string,
) => Promise<AiResult<T>>;

export interface AiResult<T> {
  output: T;
  costUsd: number;
  /** The model that answered, as the provider reports it */
  model: string | null;
}

/** Whether a provider can run: not installed, installed but logged out, or ready */
export type ProviderStatus = "missing" | "logged-out" | "ready";

/** Why a run didn't start, as flows, the map's draft and the data draft report it */
export type ProviderGap = "no-claude" | "logged-out";

export const providerGap = (status: ProviderStatus): ProviderGap | null =>
  status === "ready" ? null : status === "missing" ? "no-claude" : status;

export interface AiProvider {
  id: "claude";
  /** For copy: "Claude Code" */
  name: string;
  /** The model it will use, for the record */
  model(): string;
  status(): Promise<ProviderStatus>;
  run: Runner;
}

export const AI_PROVIDERS: AiProvider[] = [claudeCode];

/** BACKSTORY_AI picks one by id; Claude Code by default. */
export function aiProvider(): AiProvider {
  const id = process.env.BACKSTORY_AI || "claude";
  const provider = AI_PROVIDERS.find((p) => p.id === id);
  if (!provider)
    throw new Error(
      `BACKSTORY_AI is "${id}", which isn't a provider Backstory knows. Use one of: ${AI_PROVIDERS.map((p) => p.id).join(", ")}.`,
    );
  return provider;
}
