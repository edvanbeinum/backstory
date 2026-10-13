/**
 * `backstory setup claude` — adds Backstory's Stop hook and `/backstory-review`
 * to Claude Code, and takes them out again.
 *
 * Both name the `backstory` script in the Mac app by its full path, so they
 * need no PATH entry and no `npm link`. The script finds its bundle itself, so
 * a Sparkle update, which replaces the app at the same path, keeps them
 * working.
 *
 * `settings.json` is the user's file: a plan only reads it, an unreadable one
 * is never written, and a write keeps every key, hook and matcher group that
 * isn't Backstory's.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isBackstoryHook } from "./hook.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The launcher sits next to this module only in the Mac app's bundle. */
export const BUNDLED_SCRIPT = path.join(here, "backstory");
const TEMPLATE = path.join(
  here,
  "..",
  "packaging",
  "claude",
  "backstory-review.md",
);
/** Where the launcher lives in any copy of the app; marks a command file setup wrote. */
const BUNDLE_MARK = "/Contents/Resources/bin/backstory";

export const NO_SCRIPT =
  "this backstory isn't the Mac app's; set it up from Backstory's Mac app.";

/** Quotes `text` for `sh`, which is what Claude Code runs a hook's command with. */
export function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function defaultClaudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

const tilde = (file) =>
  file.startsWith(homedir() + "/") ? `~${file.slice(homedir().length)}` : file;

/**
 * @typedef {{ claudeDir?: string, script?: string | null, template?: string }} SetupOptions
 * @typedef {"none" | "current" | "stale" | "error"} SetupState
 * @typedef {{
 *   state: SetupState,
 *   changes: string[],
 *   settings: Record<string, unknown> | null,
 *   command: string,
 *   message?: string,
 * }} SetupPlan
 */

/**
 * Reads what's there and says what the button would do: set up for `none`
 * and `stale`, remove for `current`. `changes` describes that in words for
 * the alert, and `settings` is the file it would leave.
 *
 * @param {SetupOptions} [opts]
 * @returns {SetupPlan}
 */
export function planClaudeSetup(opts = {}) {
  const ctx = context(opts);
  const read = readSettings(ctx.settingsFile);
  if ("error" in read) {
    return {
      state: "error",
      changes: [],
      settings: null,
      command: ctx.command,
      message: read.error,
    };
  }
  const commandFile = readCommandFile(ctx.commandFile);
  const hooks = backstoryHooks(read.settings);
  const current =
    hooks.length === 1 &&
    hooks[0].command === ctx.command &&
    commandFile === ctx.rendered;
  if (current) {
    return {
      state: "current",
      changes: undoChanges(ctx, hooks, commandFile),
      settings: takeOut(read.settings),
      command: ctx.command,
    };
  }
  return {
    state: hooks.length === 0 ? "none" : "stale",
    changes: setUpChanges(ctx, hooks, commandFile),
    settings: setUp(read.settings, ctx.command),
    command: ctx.command,
  };
}

/**
 * Writes the Stop hook and `/backstory-review`, taking over any Backstory
 * hook already there. Returns the plan it carried out; on `error` it wrote
 * nothing.
 *
 * @param {SetupOptions} [opts]
 * @returns {SetupPlan}
 */
export function applyClaudeSetup(opts = {}) {
  const plan = planClaudeSetup(opts);
  if (plan.state === "error" || plan.state === "current") return plan;
  const ctx = context(opts);
  writeAtomic(ctx.settingsFile, JSON.stringify(plan.settings, null, 2) + "\n");
  writeAtomic(ctx.commandFile, ctx.rendered);
  return plan;
}

/**
 * Takes out every Backstory hook, and `/backstory-review` when setup wrote it.
 * A copy of the command made by hand stays.
 *
 * @param {SetupOptions} [opts]
 * @returns {{ state: "removed" | "error", changes: string[], message?: string }}
 */
export function undoClaudeSetup(opts = {}) {
  const ctx = context(opts);
  const read = readSettings(ctx.settingsFile);
  if ("error" in read)
    return { state: "error", changes: [], message: read.error };
  const hooks = backstoryHooks(read.settings);
  const commandFile = readCommandFile(ctx.commandFile);
  const changes = undoChanges(ctx, hooks, commandFile);
  if (hooks.length > 0) {
    writeAtomic(
      ctx.settingsFile,
      JSON.stringify(takeOut(read.settings), null, 2) + "\n",
    );
  }
  if (commandFile?.includes(BUNDLE_MARK)) rmSync(ctx.commandFile);
  return { state: "removed", changes };
}

/** @param {SetupOptions} opts */
function context(opts) {
  const claudeDir = opts.claudeDir ?? defaultClaudeDir();
  const script =
    opts.script === undefined
      ? existsSync(BUNDLED_SCRIPT)
        ? BUNDLED_SCRIPT
        : null
      : opts.script;
  if (!script) throw new Error(NO_SCRIPT);
  const quoted = shellQuote(script);
  return {
    settingsFile: path.join(claudeDir, "settings.json"),
    commandFile: path.join(claudeDir, "commands", "backstory-review.md"),
    command: `${quoted} hook stop`,
    rendered: readFileSync(opts.template ?? TEMPLATE, "utf8").replaceAll(
      "backstory review",
      `${quoted} review`,
    ),
  };
}

/** @returns {{ settings: Record<string, any> } | { error: string }} */
function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { settings: {} };
    return { error: `Couldn't read ${tilde(file)}: ${err.message}` };
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    return { error: `${tilde(file)} isn't valid JSON: ${err.message}` };
  }
  if (!isObject(settings)) {
    return { error: `${tilde(file)} doesn't hold a JSON object.` };
  }
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    return { error: `"hooks" in ${tilde(file)} isn't an object.` };
  }
  const stop = settings.hooks?.Stop;
  if (stop !== undefined && !Array.isArray(stop)) {
    return { error: `"hooks.Stop" in ${tilde(file)} isn't a list.` };
  }
  return { settings };
}

function readCommandFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every Backstory hook object in the Stop groups, in order. */
function backstoryHooks(settings) {
  const stop = settings.hooks?.Stop ?? [];
  return stop.flatMap((group) =>
    isObject(group) && Array.isArray(group.hooks)
      ? group.hooks.filter((hook) => isBackstoryHook(hook?.command))
      : [],
  );
}

/**
 * Points the first Backstory hook at `command` where it stands and drops any
 * others, so there is one; appends a group for it when there's none.
 */
function setUp(settings, command) {
  const next = structuredClone(settings);
  let kept = false;
  for (const group of next.hooks?.Stop ?? []) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter((hook) => {
      if (!isBackstoryHook(hook?.command)) return true;
      if (kept) return false;
      hook.command = command;
      kept = true;
      return true;
    });
  }
  if (kept) return prune(next, settings);
  next.hooks ??= {};
  next.hooks.Stop ??= [];
  next.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  return next;
}

function takeOut(settings) {
  const next = structuredClone(settings);
  for (const group of next.hooks?.Stop ?? []) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter((hook) => !isBackstoryHook(hook?.command));
  }
  return prune(next, settings);
}

/**
 * Drops the matcher groups, `Stop` and `hooks` that `next` emptied, leaving
 * any that were already empty in `before` alone.
 */
function prune(next, before) {
  const was = before.hooks?.Stop ?? [];
  if (!next.hooks?.Stop) return next;
  next.hooks.Stop = next.hooks.Stop.filter(
    (group, i) =>
      !(
        isObject(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.length === 0 &&
        was[i].hooks.length > 0
      ),
  );
  if (next.hooks.Stop.length === 0 && was.length > 0) delete next.hooks.Stop;
  if (Object.keys(next.hooks).length === 0 && Object.keys(before.hooks).length)
    delete next.hooks;
  return next;
}

function setUpChanges(ctx, hooks, commandFile) {
  const settings = tilde(ctx.settingsFile);
  const changes = [];
  if (hooks.length === 0) {
    changes.push(`Add a Stop hook to ${settings} that runs ${ctx.command}`);
  } else {
    for (const [i, hook] of hooks.entries()) {
      if (i === 0 && hook.command === ctx.command) continue;
      changes.push(
        i === 0
          ? `Change the Stop hook in ${settings} from ${hook.command} to ${ctx.command}`
          : `Remove the extra Stop hook ${hook.command} from ${settings}`,
      );
    }
  }
  if (commandFile !== ctx.rendered) {
    changes.push(
      `${commandFile === null ? "Add" : "Update"} /backstory-review at ${tilde(ctx.commandFile)}`,
    );
  }
  return changes;
}

function undoChanges(ctx, hooks, commandFile) {
  const changes = hooks.map(
    (hook) =>
      `Remove the Stop hook ${hook.command} from ${tilde(ctx.settingsFile)}`,
  );
  if (commandFile?.includes(BUNDLE_MARK)) {
    changes.push(`Delete /backstory-review at ${tilde(ctx.commandFile)}`);
  }
  return changes;
}

/**
 * Writes through a symlink to its target, so a dotfiles link stays a link,
 * and by renaming a temp file in the same folder, so Claude Code never reads
 * half a file.
 */
function writeAtomic(file, text) {
  let target = file;
  let mode = 0o644;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  } catch {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode });
  renameSync(temp, target);
}
