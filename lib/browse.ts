import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { gitLine, gitTry } from "./exec";
import { expandPath } from "./git";

/**
 * Finding a checkout without typing its path.
 *
 * A browser-native folder picker can't help: `webkitdirectory` only ever
 * yields paths relative to the chosen directory, never the absolute one the
 * server needs. So the browsing happens here, where the filesystem actually
 * is — read-only, directory names only, never file contents.
 */

export interface DirEntry {
  name: string;
  path: string;
  /** A git work tree — worth offering as a one-click choice */
  isRepo: boolean;
}

export interface WorktreeEntry {
  path: string;
  name: string;
  branch: string | null;
  /** Tip commit, straight from the porcelain output — free, so keep it */
  head?: string | null;
  /** True for the checkout the browse started from */
  isCurrent: boolean;
  /** A worktree whose directory is gone (pruned but still registered) */
  missing?: boolean;
}

export interface BrowseResult {
  /** Absolute directory being listed */
  path: string;
  /** Parent directory, or null at the filesystem root */
  parent: string | null;
  entries: DirEntry[];
  /** Sibling worktrees of the current repo, when there is one */
  worktrees: WorktreeEntry[];
}

/** Directories that are never a checkout you want to open. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "DerivedData",
  "Library",
  ".Trash",
  ".cache",
  ".npm",
  ".cargo",
  "venv",
  ".venv",
]);

/** Cap the listing: a home directory can hold thousands of entries. */
const MAX_ENTRIES = 400;

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    // A worktree's .git is a file, not a directory — stat, don't isDirectory.
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every worktree registered against `repoPath`'s repository, which for a
 * stacked-branch workflow is the list you actually want: all the sibling
 * checkouts, with the branch each one holds.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<WorktreeEntry[]> {
  const root = await gitLine(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!root) return [];

  const out = await gitTry(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> & { path?: string; bare?: boolean } = {};

  const flush = () => {
    if (!current.path) return;
    // A bare repository has no working tree to review, and listing it
    // produces a branchless phantom row.
    if (!current.bare) {
      entries.push({
        path: current.path,
        name: path.basename(current.path),
        branch: current.branch ?? null,
        head: current.head ?? null,
        isCurrent: current.path === root,
        ...(current.missing ? { missing: true } : {}),
      });
    }
    current = {};
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      // refs/heads/feature/x → feature/x
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("detached")) {
      current.branch = null;
    } else if (line.startsWith("bare")) {
      current.bare = true;
    } else if (line.startsWith("prunable")) {
      current.missing = true;
    }
  }
  flush();

  // The current checkout first, then alphabetically — the rest are siblings
  // and their order carries no meaning.
  return entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** List the directories inside `dir`, flagging which are checkouts. */
export async function browse(
  dir: string,
  currentRepo?: string | null,
): Promise<BrowseResult> {
  const target = dir ? expandPath(dir) : homedir();

  let names: string[] = [];
  try {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    names = dirents
      .filter((d) => {
        // Follow symlinked checkouts, which are common in worktree setups
        if (!d.isDirectory() && !d.isSymbolicLink()) return false;
        return !SKIP.has(d.name);
      })
      .map((d) => d.name)
      .sort((a, b) => {
        // Dotfiles last: they're rarely what you're looking for
        const aDot = a.startsWith(".");
        const bDot = b.startsWith(".");
        if (aDot !== bDot) return aDot ? 1 : -1;
        return a.localeCompare(b);
      })
      .slice(0, MAX_ENTRIES);
  } catch {
    // Unreadable directory — report it as empty rather than failing the panel
    names = [];
  }

  const entries = await Promise.all(
    names.map(async (name) => {
      const full = path.join(target, name);
      return { name, path: full, isRepo: await isGitRepo(full) };
    }),
  );

  const parent = path.dirname(target);

  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
    worktrees: currentRepo ? await listWorktrees(currentRepo) : [],
  };
}
