import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * When the Mac app runs the server, or anything but a login shell launches
 * it, PATH is the bare system default — no /opt/homebrew/bin, so no `gh`, and
 * on some setups no usable `git`.
 * Augment PATH once, at module load, with the places those tools actually
 * live. Appending (not prepending) means a user's own PATH still wins.
 */
const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin", // Homebrew on Apple silicon
  "/usr/local/bin", // Homebrew on Intel, and general local installs
  path.join(homedir(), ".local", "bin"), // Claude Code's native installer
];

{
  const current = (process.env.PATH ?? "").split(path.delimiter);
  const missing = EXTRA_PATH_DIRS.filter(
    (dir) => !current.includes(dir) && existsSync(dir),
  );
  if (missing.length > 0) {
    process.env.PATH = [...current, ...missing].join(path.delimiter);
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

interface RunOptions {
  cwd?: string;
  timeout?: number;
  /** Max bytes of stdout to buffer. Large diffs need plenty of headroom. */
  maxBuffer?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Exit codes to treat as success. `git diff --no-index` exits 1 when it
   * finds differences, which is the normal case, not an error.
   */
  allowExitCodes?: number[];
}

/**
 * Run a binary with an argv array. Never a shell string — the repo path and
 * refs come from user input, and this app happily points at any directory on
 * the machine.
 */
export function run(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  const {
    cwd,
    timeout = 30_000,
    maxBuffer = 64 * 1024 * 1024,
    input,
    env,
    allowExitCodes = [],
  } = opts;

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        timeout,
        maxBuffer,
        encoding: "utf8",
        env: env ?? process.env,
        // git pagers and credential prompts would hang a server request
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as NodeJS.ErrnoException & { code?: number }).code ===
            "number"
              ? ((err as unknown as { code: number }).code ?? 1)
              : 1;

          if (allowExitCodes.includes(code)) {
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
            return;
          }

          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new ExecError(
                `${file} not found on PATH`,
                `${file} ${args.join(" ")}`,
                127,
                stderr ?? "",
              ),
            );
            return;
          }

          reject(
            new ExecError(
              stderr?.trim() || err.message,
              `${file} ${args.join(" ")}`,
              code,
              stderr ?? "",
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/**
 * Run a git command in `cwd`. Disables the pager and any interactive
 * credential prompt so a request can never hang waiting on a terminal.
 */
export async function git(cwd: string, args: string[], opts: RunOptions = {}) {
  return run(
    "git",
    [
      "--no-pager",
      // Raw UTF-8 paths instead of C-quoted ones, and never let a user's
      // difftool/textconv config rewrite the patch we're about to parse.
      "-c",
      "core.quotepath=false",
      "-c",
      "diff.external=",
      "-c",
      "diff.noprefix=false",
      ...args,
    ],
    {
      ...opts,
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...opts.env,
      },
    },
  );
}

/** git, but a non-zero exit resolves to null instead of throwing. */
export async function gitTry(
  cwd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, args, opts);
    return stdout;
  } catch {
    return null;
  }
}

/** Convenience: trimmed stdout, or null when the command fails. */
export async function gitLine(
  cwd: string,
  args: string[],
): Promise<string | null> {
  const out = await gitTry(cwd, args);
  const trimmed = out?.trim();
  return trimmed ? trimmed : null;
}
