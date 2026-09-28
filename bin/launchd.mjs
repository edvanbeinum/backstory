/**
 * The login agent that keeps the differ server running.
 *
 * The installed window outlives any server a terminal starts, so `differ`
 * hands the server to launchd instead: a LaunchAgent in
 * ~/Library/LaunchAgents that starts it at login and restarts it if it dies.
 * `differ` writes it the first time it finds no server running, and rewrites
 * it whenever what it would write has changed — a moved checkout, a new node,
 * a different port — so re-running `differ` is always the fix.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const LABEL = "dev.differ.server";

/** `brew services start differ` registers its own agent under this label. */
const BREW_LABEL = "homebrew.mxcl.differ";

const agentsDir = () => path.join(homedir(), "Library", "LaunchAgents");
export const plistPath = () => path.join(agentsDir(), `${LABEL}.plist`);
const target = () => `gui/${process.getuid()}/${LABEL}`;

export function supported() {
  return process.platform === "darwin";
}

/** Homebrew's service owns the server; installing ours would fight it for the port. */
export function brewServiceInstalled() {
  return existsSync(path.join(agentsDir(), `${BREW_LABEL}.plist`));
}

function xml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The agent's plist. `node` is found through the PATH captured from the shell
 * that ran `differ`, not an absolute path: launchd's own PATH is bare, and a
 * resolved node path (nvm's, a Homebrew Cellar's) is versioned and vanishes
 * on the next upgrade. The same PATH is what lets the server find git and gh.
 *
 * @param {{ server: string, port: number, pathEnv: string, log: string, differHome?: string }} spec
 */
export function renderPlist({ server, port, pathEnv, log, differHome }) {
  const env = { PORT: String(port), HOSTNAME: "127.0.0.1", PATH: pathEnv };
  if (differHome) env.DIFFER_HOME = differHome;
  const envXml = Object.entries(env)
    .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/bin/env</string>
\t\t<string>node</string>
\t\t<string>${xml(server)}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xml(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** The port an installed agent serves, read back from its plist; null if none. */
export function parsePort(plist) {
  const match = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(plist);
  return match ? Number(match[1]) : null;
}

export function installedPort() {
  try {
    return parsePort(readFileSync(plistPath(), "utf8"));
  } catch {
    return null;
  }
}

function launchctl(args) {
  return new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

export async function agentLoaded() {
  return (await launchctl(["print", target()])).ok;
}

/**
 * Make the installed agent match `spec` and make sure it's running.
 * Returns "installed" (first time), "updated" (plist rewritten, server
 * restarted onto it) or "started" (plist was already right).
 */
export async function ensureAgent(spec) {
  const plist = renderPlist(spec);
  let current = null;
  try {
    current = readFileSync(plistPath(), "utf8");
  } catch {
    // not installed yet
  }

  if (current === plist && (await agentLoaded())) {
    await launchctl(["kickstart", target()]);
    return "started";
  }

  mkdirSync(agentsDir(), { recursive: true });
  mkdirSync(path.dirname(spec.log), { recursive: true });
  writeFileSync(plistPath(), plist);
  // launchd reads a plist only when it's bootstrapped, so a changed one has
  // to be booted out and back in. RunAtLoad starts the server.
  await launchctl(["bootout", target()]);
  const boot = await launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath()]);
  if (!boot.ok) throw new Error(`launchctl bootstrap failed: ${boot.out}`);
  if (current === null) return "installed";
  return current === plist ? "started" : "updated";
}

/** Restart the agent's server, e.g. onto a rebuild. False if it isn't ours. */
export async function restartAgent() {
  if (!(await agentLoaded())) return false;
  return (await launchctl(["kickstart", "-k", target()])).ok;
}

/** Stop the server and forget the agent. False if there was nothing to remove. */
export async function uninstallAgent() {
  const had = existsSync(plistPath());
  await launchctl(["bootout", target()]);
  rmSync(plistPath(), { force: true });
  return had;
}
