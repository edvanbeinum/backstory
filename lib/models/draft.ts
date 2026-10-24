import { aiProvider, type Runner } from "../ai/provider";
import { readDsl } from "../dsl";
import { git, gitLine } from "../exec";
import { withSnapshot } from "../flows/generate";
import type { Workspace } from "../model";
import { assignIds, serializeModel, type DraftIds } from "./dsl";
import { checkGlobs } from "./globs";
import {
  draftPrompt,
  draftSchema,
  globFixPrompt,
  globFixSchema,
  type DraftOutput,
  type GlobFixOutput,
} from "./prompts";

/**
 * Drafts a C4 model in full: Claude reads the code at a commit, and Backstory
 * turns its structured answer into a `Workspace` through the DSL it writes
 * and reads, so a draft always parses. A second, bounded call fixes the globs
 * of files no component, or two components, claim. The map cache
 * (`cache.ts`) saves the result; nothing here writes a file.
 */

/** Paths the glob fix-up is shown, so a draft that missed most files stays one bounded call. */
const MAX_FIX_PATHS = 200;

interface DraftResult {
  workspace: Workspace;
  costUsd: number;
  model: string | null;
}

function applyFix(
  output: DraftOutput,
  ids: DraftIds,
  fix: GlobFixOutput,
): DraftOutput {
  const revised = new Map(fix.components.map((c) => [c.id, c.globs]));
  return {
    ...output,
    system: {
      ...output.system,
      containers: output.system.containers.map((c, i) => ({
        ...c,
        components: c.components.map((k, j) => ({
          ...k,
          globs: revised.get(ids.containers[i].components[j]) ?? k.globs,
        })),
      })),
    },
  };
}

export async function draftModel(opts: {
  root: string;
  rev: string;
  runner?: Runner;
}): Promise<DraftResult> {
  const runner = opts.runner ?? aiProvider().run;
  const sha = await gitLine(opts.root, [
    "rev-parse",
    "--verify",
    `${opts.rev}^{commit}`,
  ]);
  if (!sha) throw new Error(`No commit ${opts.rev.slice(0, 7)} to draft.`);
  const short = sha.slice(0, 7);
  // The same tracked files the snapshot holds, so the check sees what Claude saw.
  const { stdout } = await git(
    opts.root,
    ["ls-tree", "-r", "-z", "--name-only", sha],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const files = stdout.split("\0").filter(Boolean);

  return withSnapshot(opts.root, sha, async (dir) => {
    const first = await runner<DraftOutput>(
      draftPrompt({ sha: short, files: files.length }),
      draftSchema(),
      dir,
    );
    let output = first.output;
    let costUsd = first.costUsd;

    const check = checkGlobs(serializeModel(output), files);
    if (check.unmatched.length > 0 || check.ambiguous.length > 0) {
      const ids = assignIds(output);
      const unmatched = check.unmatched.slice(0, MAX_FIX_PATHS);
      const ambiguous = check.ambiguous.slice(
        0,
        MAX_FIX_PATHS - unmatched.length,
      );
      const fix = await runner<GlobFixOutput>(
        globFixPrompt({
          sha: short,
          unmatched,
          unmatchedCount: check.unmatched.length,
          ambiguous,
          ambiguousCount: check.ambiguous.length,
          components: output.system.containers.flatMap((c, i) =>
            c.components.map((k, j) => ({
              id: ids.containers[i].components[j],
              name: k.name,
              globs: k.globs,
            })),
          ),
        }),
        globFixSchema(),
        dir,
      );
      costUsd += fix.costUsd;
      output = applyFix(output, ids, fix.output);
    }

    return {
      workspace: readDsl(serializeModel(output)),
      costUsd,
      model: first.model ?? aiProvider().model(),
    };
  });
}
