import { run } from "../exec";

/**
 * Every call to Claude Code goes through here, so a change in its CLI is a
 * change in one file. differ depends on `-p`, `--json-schema` and the
 * `structured_output` field of the JSON result.
 */

export interface ClaudeResult<T> {
  output: T;
  costUsd: number;
  /** The model that answered, as Claude Code reports it */
  model: string | null;
}

/**
 * Which model traces flows: DIFFER_FLOWS_MODEL, an alias ("sonnet",
 * "opus") or a full model id. Sonnet by default: compared with Opus on the
 * same views it cost about a third, took under half the time and verified
 * every step, tracing coarser flows that still told the same story.
 */
export const flowsModel = () => process.env.DIFFER_FLOWS_MODEL || "sonnet";

/** A stand-in for Claude in tests: same contract, recorded answers. */
export type Runner = <T>(
  prompt: string,
  schema: object,
  cwd: string,
) => Promise<ClaudeResult<T>>;

/** Generation took 51–83 s in the prompt test; leave plenty of headroom. */
const TIMEOUT_MS = 15 * 60_000;

export const claudeRunner: Runner = async <T>(
  prompt: string,
  schema: object,
  cwd: string,
) => {
  const { stdout } = await run(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "--disallowedTools",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "--no-session-persistence",
      // Load no settings at all. Not the user's (plugins and hooks cost
      // tokens and can steer the answer), and above all not the reviewed
      // commit's: the snapshot is its cwd, and a .claude/settings.local.json
      // committed on a branch would otherwise run its hooks on this machine.
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--model",
      flowsModel(),
    ],
    { cwd, input: prompt, timeout: TIMEOUT_MS },
  );

  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("Claude Code returned no JSON.");
  const result = JSON.parse(stdout.slice(start)) as {
    is_error?: boolean;
    result?: string;
    structured_output?: T;
    total_cost_usd?: number;
    modelUsage?: Record<string, unknown>;
  };
  if (result.is_error || result.structured_output === undefined) {
    throw new Error(`Claude Code failed: ${result.result ?? "no structured output"}`);
  }
  return {
    output: result.structured_output,
    costUsd: result.total_cost_usd ?? 0,
    model: mainModel(result.modelUsage),
  };
};

/** A run can use more than one model; the one that cost the most did the work. */
function mainModel(usage: Record<string, unknown> | undefined): string | null {
  const cost = (u: unknown) => ((u as { costUSD?: number })?.costUSD ?? 0);
  return Object.entries(usage ?? {}).sort((a, b) => cost(b[1]) - cost(a[1]))[0]?.[0] ?? null;
}

export async function claudeAvailable(): Promise<boolean> {
  try {
    await run("claude", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
