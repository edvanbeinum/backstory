import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setAutoRead } from "../lib/data/cache";
import { SETUP_DETAILS, setupChecks, type SetupId } from "../lib/setup";
import {
  githubApiStandIn,
  quietLoginShell,
  SECURITY,
  standIns,
} from "./standins";

quietLoginShell();

const GIT = 'echo "git version 2.50.0"';

/** A `settings.json` folder standing in for `~/.claude`; none when `settings` is undefined. */
function claudeDir(settings?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "backstory-claude-"));
  if (settings !== undefined)
    writeFileSync(path.join(dir, "settings.json"), settings);
  return dir;
}

async function checks(
  scripts: Record<string, string>,
  opts: {
    claudeDir?: string;
    gitShim?: (dir: string) => string;
    before?: (dir: string) => void;
  } = {},
) {
  const dir = standIns(scripts);
  opts.before?.(dir);
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    const rows = await setupChecks({
      claudeDir: opts.claudeDir ?? claudeDir(),
      gitShim: opts.gitShim?.(dir),
    });
    return {
      dir,
      rows,
      state: (id: SetupId) => rows.find((row) => row.id === id)?.state,
    };
  } finally {
    process.env.PATH = saved;
  }
}

test("with git but no gh and no Claude Code, the checklist says what each missing piece unlocks", async () => {
  const { rows } = await checks({ git: GIT });
  assert.deepEqual(rows, [
    { id: "git", state: "ready", detail: SETUP_DETAILS.git },
    { id: "github", state: "missing", detail: SETUP_DETAILS.github },
    { id: "claude", state: "missing", detail: SETUP_DETAILS.claude },
    { id: "reviews", state: "missing", detail: SETUP_DETAILS.reviews },
  ]);
  assert.match(SETUP_DETAILS.github, /review comments/);
  assert.match(SETUP_DETAILS.claude, /explained/);
  assert.match(SETUP_DETAILS.reviews, /coding agent/);
});

test("Claude Code's row tells not installed, logged out and ready apart", async () => {
  const claude = (auth: string, code = 0) =>
    `if [ "$1" = auth ]; then echo '${auth}'; exit ${code}; fi\necho "2.1.0 (Claude Code)"`;
  assert.equal((await checks({ git: GIT })).state("claude"), "missing");
  assert.equal(
    (
      await checks({ git: GIT, claude: claude('{"loggedIn": false}', 1) })
    ).state("claude"),
    "logged-out",
  );
  assert.equal(
    (await checks({ git: GIT, claude: claude('{"loggedIn": true}') })).state(
      "claude",
    ),
    "ready",
  );
});

test("the Data models row shows once Claude Code is ready, and is ready once reading is turned on", async () => {
  process.env.BACKSTORY_HOME = mkdtempSync(
    path.join(os.tmpdir(), "backstory-setup-"),
  );
  const claude = (loggedIn: boolean) =>
    `if [ "$1" = auth ]; then echo '{"loggedIn": ${loggedIn}}'; exit ${loggedIn ? 0 : 1}; fi\necho "2.1.0 (Claude Code)"`;
  const rows = async (loggedIn: boolean) =>
    (await checks({ git: GIT, claude: claude(loggedIn) })).rows.map(
      (row) => row.id,
    );
  assert.deepEqual(await rows(false), ["git", "github", "claude", "reviews"]);
  assert.deepEqual(await rows(true), [
    "git",
    "github",
    "claude",
    "data",
    "reviews",
  ]);

  const data = async () =>
    (await checks({ git: GIT, claude: claude(true) })).state("data");
  assert.equal(await data(), "missing");
  setAutoRead(true);
  assert.equal(await data(), "ready");
  setAutoRead(false);
  assert.equal(await data(), "missing");
  assert.match(
    SETUP_DETAILS.data,
    /once for main .* then only what each change differs by/,
  );
});

test("GitHub's row tells no gh, logged out and ready apart", async () => {
  assert.equal((await checks({ git: GIT })).state("github"), "missing");
  assert.equal(
    (await checks({ git: GIT, gh: 'echo "not logged in" >&2; exit 1' })).state(
      "github",
    ),
    "logged-out",
  );
  assert.equal(
    (await checks({ git: GIT, gh: "exit 0" })).state("github"),
    "ready",
  );
});

/** GitHub's row on a machine with no `gh`, a saved token, and `api` answering for GitHub. */
async function githubRowWithToken(api: string) {
  const saved = process.env.BACKSTORY_GITHUB_API;
  process.env.BACKSTORY_GITHUB_API = api;
  try {
    const { dir, state } = await checks(
      { git: GIT, security: SECURITY },
      {
        before: (dir) =>
          writeFileSync(path.join(dir, "keychain"), "gho_saved1"),
      },
    );
    return {
      state: state("github"),
      kept: existsSync(path.join(dir, "keychain")),
    };
  } finally {
    if (saved === undefined) delete process.env.BACKSTORY_GITHUB_API;
    else process.env.BACKSTORY_GITHUB_API = saved;
  }
}

test("GitHub's row is ready with a working saved token and no gh", async () => {
  const api = await githubApiStandIn(() => ({
    json: { data: { viewer: { login: "ed" } } },
  }));
  try {
    assert.deepEqual(await githubRowWithToken(api.url), {
      state: "ready",
      kept: true,
    });
    assert.equal(api.calls[0].authorization, "Bearer gho_saved1");
  } finally {
    await api.close();
  }
});

test("a revoked saved token is forgotten, and the row offers Connect GitHub again", async () => {
  const api = await githubApiStandIn(() => ({ status: 401 }));
  try {
    assert.deepEqual(await githubRowWithToken(api.url), {
      state: "missing",
      kept: false,
    });
  } finally {
    await api.close();
  }
});

test("a saved token with no network keeps the row ready", async () => {
  assert.deepEqual(await githubRowWithToken("http://127.0.0.1:1"), {
    state: "ready",
    kept: true,
  });
});

test("a git that is only Apple's shim reads as missing without running it", async () => {
  const { dir, state } = await checks(
    { git: '/usr/bin/touch "${0%/*}/git-ran"', "xcode-select": "exit 2" },
    { gitShim: (dir) => path.join(dir, "git") },
  );
  assert.equal(state("git"), "missing");
  assert.equal(existsSync(path.join(dir, "git-ran")), false);
});

test("the shim's git runs once the command line tools are installed", async () => {
  const { state } = await checks(
    { git: GIT, "xcode-select": "echo /Library/Developer/CommandLineTools" },
    { gitShim: (dir) => path.join(dir, "git") },
  );
  assert.equal(state("git"), "ready");
});

test("notes to your agent are ready only once a Backstory Stop hook can run and /backstory-review is there", async () => {
  const stop = (...commands: string[]) =>
    JSON.stringify({
      hooks: {
        Stop: commands.map((command) => ({
          hooks: [{ type: "command", command }],
        })),
      },
    });
  const withCommand = (dir: string) => {
    mkdirSync(path.join(dir, "commands"));
    writeFileSync(path.join(dir, "commands", "backstory-review.md"), "");
    return dir;
  };
  const reviews = async (dir: string, onPath: Record<string, string> = {}) =>
    (await checks({ git: GIT, ...onPath }, { claudeDir: dir })).state(
      "reviews",
    );
  const backstory = { backstory: "exit 0" };

  assert.equal(await reviews(claudeDir()), "missing");
  assert.equal(await reviews(claudeDir("{ not json")), "missing");
  assert.equal(
    await reviews(withCommand(claudeDir(stop("other-tool stop"))), backstory),
    "missing",
  );
  const bare = stop("other-tool stop", "backstory hook stop");
  assert.equal(await reviews(claudeDir(bare), backstory), "missing");
  assert.equal(await reviews(withCommand(claudeDir(bare))), "missing");
  assert.equal(await reviews(withCommand(claudeDir(bare)), backstory), "ready");

  const app = mkdtempSync(path.join(os.tmpdir(), "backstory app "));
  const script = path.join(app, "backstory");
  writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
  const quoted = stop(`'${script}' hook stop`);
  assert.equal(await reviews(withCommand(claudeDir(quoted))), "ready");
  rmSync(script);
  assert.equal(await reviews(withCommand(claudeDir(quoted))), "missing");
});
