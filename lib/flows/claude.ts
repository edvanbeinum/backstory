import { run } from "../exec";

/**
 * Every call to Claude Code goes through here, so a change in its CLI is a
 * change in one file. differ depends on `-p`, `--json-schema` and the
 * `structured_output` field of the JSON result.
 */

export interface ClaudeResult<T> {
  output: T;
  costUsd: number;
}

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
      // Skip the user's plugins, hooks and MCP servers: they cost tokens on
      // every run (startup fell from $0.18 to $0.03) and can steer the answer.
      "--strict-mcp-config",
      "--setting-sources",
      "local",
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
  };
  if (result.is_error || result.structured_output === undefined) {
    throw new Error(`Claude Code failed: ${result.result ?? "no structured output"}`);
  }
  return { output: result.structured_output, costUsd: result.total_cost_usd ?? 0 };
};

export async function claudeAvailable(): Promise<boolean> {
  try {
    await run("claude", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
