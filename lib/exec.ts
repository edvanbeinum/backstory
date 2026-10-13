import { execFile } from "node:child_process";
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

/**
 * Appends the tool directories PATH lacks, including ones that don't exist
 * yet, so a `claude` installed after the server started is found on the next
 * spawn without a restart. A missing directory on PATH costs nothing.
 */
export function withToolDirs(
  current: string,
  extra: string[] = EXTRA_PATH_DIRS,
): string {
  const dirs = current.split(path.delimiter);
  const missing = extra.filter((dir) => !dirs.includes(dir));
  return [...dirs, ...missing].join(path.delimiter);
}

process.env.PATH = withToolDirs(process.env.PATH ?? "");

/** The tools a user's shell config may put on PATH where no fixed folder would find them (nvm, asdf, mise). */
const LOGIN_SHELL_TOOLS = ["gh", "claude"];
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/**
 * Asks the user's login shell where `tools` live, the way their terminal
 * would find them, and returns those folders. Only absolute paths to a named
 * tool count, so aliases, functions and whatever `.zshrc` prints are ignored.
 * A shell that fails, hangs or finds nothing yields [], which leaves PATH as
 * it was.
 */
export async function loginShellDirs(
  shell: string,
  tools: string[],
  timeoutMs: number,
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  // Race a timer as well as run's own timeout: killing the shell doesn't end
  // a child it started that still holds stdout open.
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const result = await Promise.race([
      run(shell, ["-lic", `command -v ${tools.join(" ")}`], {
        timeout: timeoutMs,
        // `command -v` exits 1 when any one tool is missing, but still prints the rest
        allowExitCodes: [1],
        // Close stdin, so a prompt in the user's shell config can't wait on it
        input: "",
      }),
      timedOut,
    ]);
    if (!result) return [];
    const dirs = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) => path.isAbsolute(line) && tools.includes(path.basename(line)),
      )
      .map((line) => path.dirname(line));
    return [...new Set(dirs)];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Kept on globalThis because Next may load this module once per route bundle,
// and each copy would otherwise start the user's shell again.
const memo = globalThis as { __backstoryLoginDirs?: Promise<string[]> };

function loginDirs(): Promise<string[]> {
  return (memo.__backstoryLoginDirs ??= loginShellDirs(
    process.env.SHELL || "/bin/zsh",
    LOGIN_SHELL_TOOLS,
    LOGIN_SHELL_TIMEOUT_MS,
  ).then((dirs) => {
    process.env.PATH = withToolDirs(process.env.PATH ?? "", dirs);
    return dirs;
  }));
}

/** Asks the login shell again, for a tool installed since the server started. */
export function refreshLoginShellDirs(): Promise<string[]> {
  memo.__backstoryLoginDirs = undefined;
  return loginDirs();
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
export async function run(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<ExecResult> {
  const {
    cwd,
    timeout = 30_000,
    maxBuffer = 64 * 1024 * 1024,
    input,
    allowExitCodes = [],
  } = opts;
  let { env } = opts;
  // Only the tools the login shell is asked about wait on it: git and the
  // shell pipelines around it run on every request and resolve from /usr/bin.
  if (LOGIN_SHELL_TOOLS.includes(file)) {
    const dirs = await loginDirs();
    if (env) env = { ...env, PATH: withToolDirs(env.PATH ?? "", dirs) };
  }

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
