import { run } from "../exec";
import type { AiProvider, Runner } from "./provider";

/**
 * Every call to Claude Code goes through here, so a change in its CLI is a
 * change in one file. Backstory depends on `-p`, `--json-schema` and the
 * `structured_output` field of the JSON result.
 */

/**
 * Which model traces flows: BACKSTORY_FLOWS_MODEL, an alias ("sonnet",
 * "opus") or a full model id. Sonnet by default: compared with Opus on the
 * same views it cost about a third, took under half the time and verified
 * every step, tracing coarser flows that still told the same story.
 */
const flowsModel = () => process.env.BACKSTORY_FLOWS_MODEL || "sonnet";

/** Generation took 51–83 s in the prompt test; leave plenty of headroom. */
const TIMEOUT_MS = 15 * 60_000;

const claudeRunner: Runner = async <T>(
  prompt: string,
  schema: object,
  cwd: string,
) => {
  // On failure Claude Code still prints its JSON, with the reason in
  // `result`; read it rather than a "Command failed" carrying the schema.
  const { stdout, stderr } = await run(
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
    { cwd, input: prompt, timeout: TIMEOUT_MS, allowExitCodes: [1] },
  );

  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(
      `Claude Code returned no JSON${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "."}`,
    );
  }
  const result = JSON.parse(stdout.slice(start)) as {
    is_error?: boolean;
    result?: string;
    structured_output?: T;
    total_cost_usd?: number;
    modelUsage?: Record<string, unknown>;
  };
  if (result.is_error || result.structured_output === undefined) {
    throw new Error(
      `Claude Code failed: ${result.result ?? "no structured output"}`,
    );
  }
  return {
    output: result.structured_output,
    costUsd: result.total_cost_usd ?? 0,
    model: mainModel(result.modelUsage),
  };
};

/** A run can use more than one model; the one that cost the most did the work. */
function mainModel(usage: Record<string, unknown> | undefined): string | null {
  const cost = (u: unknown) => (u as { costUSD?: number })?.costUSD ?? 0;
  return (
    Object.entries(usage ?? {}).sort(
      (a, b) => cost(b[1]) - cost(a[1]),
    )[0]?.[0] ?? null
  );
}

async function claudeAvailable(): Promise<boolean> {
  try {
    await run("claude", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export const claudeCode: AiProvider = {
  id: "claude",
  name: "Claude Code",
  setup: "Install Claude Code and sign in",
  model: flowsModel,
  available: claudeAvailable,
  run: claudeRunner,
};
