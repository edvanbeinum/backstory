import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { backstoryHookProgram } from "../bin/hook.mjs";
import { aiProvider } from "./ai/provider";
import { autoRead } from "./data/cache";
import { refreshLoginShellDirs, run } from "./exec";
import { gh, githubTokenWorks } from "./github";

/**
 * The setup checklist's checks: what Backstory needs on this machine, and
 * what each piece unlocks. Each one only looks, and changes nothing, except
 * that a saved GitHub token GitHub refuses is forgotten. The Maps and data
 * models row is the user's permission to spend on reading maps and data
 * models, so it shows only once Claude Code, which does the reading, is
 * ready.
 */

export type SetupId = "git" | "github" | "claude" | "data" | "reviews";
export type SetupState = "missing" | "logged-out" | "ready";

export interface SetupRow {
  id: SetupId;
  state: SetupState;
  /** What it unlocks, for the row's copy */
  detail: string;
}

export const SETUP_DETAILS: Record<SetupId, string> = {
  git: "See what changed on every branch, commit by commit.",
  github:
    "Bring your pull request's review comments in beside the code they're about.",
  claude:
    "Have a change explained: how it runs, step by step, and a map of the system and data it touches.",
  data: "Read each repo's map and data model with Claude Code as you open it: once for main (each about a dollar and a few minutes on a large repo, cents on a small one), then only what each change differs by (cents, well under a minute).",
  reviews:
    "Comment on what your coding agent wrote and send the notes straight to it, even while it's still working.",
};

/** On a Mac without the command line tools this is a shim, and running it opens Apple's install dialog. */
const GIT_SHIM = "/usr/bin/git";
const TIMEOUT_MS = 15_000;

interface SetupOptions {
  /** Where Claude Code keeps settings.json: `$CLAUDE_CONFIG_DIR`, or `~/.claude` */
  claudeDir?: string;
  /** Stands in for `/usr/bin/git`, for tests */
  gitShim?: string;
}

export async function setupChecks(
  opts: SetupOptions = {},
): Promise<SetupRow[]> {
  const claudeDir =
    opts.claudeDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(homedir(), ".claude");
  const [git, github, claude, reviews] = await Promise.all([
    gitState(opts.gitShim ?? GIT_SHIM),
    githubState(),
    aiProvider().status(),
    reviewsState(claudeDir),
  ]);
  const data = autoRead() ? "ready" : "missing";
  const states: Record<SetupId, SetupState> = {
    git,
    github,
    claude,
    data,
    reviews,
  };
  return (Object.keys(SETUP_DETAILS) as SetupId[])
    .filter((id) => id !== "data" || claude === "ready")
    .map((id) => ({
      id,
      state: states[id],
      detail: SETUP_DETAILS[id],
    }));
}

/**
 * Runs the checks, and when `gh` or `claude` is missing asks the login shell
 * again and checks once more, so a tool installed since the server started
 * (through nvm, say) is found without a restart.
 */
export async function setupChecksFresh(
  opts: SetupOptions = {},
): Promise<SetupRow[]> {
  const rows = await setupChecks(opts);
  const lacking = rows.some(
    (row) =>
      (row.id === "github" || row.id === "claude") && row.state === "missing",
  );
  if (!lacking) return rows;
  await refreshLoginShellDirs();
  return setupChecks(opts);
}

async function onPath(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      await fs.access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

async function succeeds(file: string, args: string[]): Promise<boolean> {
  try {
    await run(file, args, { timeout: TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function gitState(shim: string): Promise<SetupState> {
  const git = await onPath("git");
  if (!git) return "missing";
  if (git === shim && !(await succeeds("xcode-select", ["-p"])))
    return "missing";
  return (await succeeds(git, ["--version"])) ? "ready" : "missing";
}

/**
 * Ready with a working saved token, otherwise with a signed-in `gh`: the same
 * order every GitHub read takes. A refused token is forgotten here, so the
 * row offers Connect GitHub again.
 */
async function githubState(): Promise<SetupState> {
  if (await githubTokenWorks()) return "ready";
  try {
    // Scoped to github.com: a bad token for another host fails the bare command
    await gh(process.cwd(), ["auth", "status", "--hostname", "github.com"]);
    return "ready";
  } catch (err) {
    return (err as { code?: unknown }).code === 127 ? "missing" : "logged-out";
  }
}

interface HookEntry {
  hooks?: { command?: unknown }[];
}

/**
 * Ready once a Backstory Stop hook can run and `/backstory-review` is there,
 * as Set Up leaves them. A hook naming an app that has since moved counts as
 * missing, so the row offers Set Up, which points it at this app again.
 * Never writes either file.
 */
async function reviewsState(claudeDir: string): Promise<SetupState> {
  let stop: HookEntry[] | undefined;
  try {
    const settings = JSON.parse(
      await fs.readFile(path.join(claudeDir, "settings.json"), "utf8"),
    ) as { hooks?: { Stop?: HookEntry[] } };
    stop = settings.hooks?.Stop;
  } catch {
    return "missing";
  }
  const programs = (Array.isArray(stop) ? stop : []).flatMap((entry) =>
    Array.isArray(entry?.hooks)
      ? entry.hooks.map((hook) => backstoryHookProgram(hook?.command))
      : [],
  );
  const runs = await Promise.all(
    programs.map((program) => program !== null && canRun(program)),
  );
  if (!runs.includes(true)) return "missing";
  try {
    await fs.access(path.join(claudeDir, "commands", "backstory-review.md"));
    return "ready";
  } catch {
    return "missing";
  }
}

/** Whether `sh` would find `program`: a path that's executable, or a name on PATH. */
async function canRun(program: string): Promise<boolean> {
  if (!program.includes("/")) return (await onPath(program)) !== null;
  try {
    await fs.access(program, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
