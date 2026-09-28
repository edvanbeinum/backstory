# Packaging differ

The goal: differ lives in the dock and app switcher like any other app, with
a server that's always up, and a `differ` command that opens whatever repo
you're standing in.

## The three pieces

1. **The installed app window.** differ serves a web app manifest, so the
   running site can be installed as a standalone window:
   - Chrome: ⋮ → *Cast, save and share* → *Install page as app…*
   - Safari (Sonoma+): *File → Add to Dock*

   The installed window gets its own dock icon and Cmd-Tab entry. It always
   opens at `/`; repo selection reaches it through the handoff below.

2. **The always-on server.** The first `differ` that finds no server running
   installs a launchd agent (`dev.differ.server`, see `bin/launchd.mjs`)
   running the standalone build on `127.0.0.1:4460`, kept alive across
   logins. It records the PATH of the shell it was installed from, so it
   finds the same `node`, `git` and `gh`; whenever that or the build moves,
   the next `differ` rewrites it. `brew services start differ` does the same
   job under Homebrew's label, and the CLI defers to it when it's installed.
   `--foreground` (and non-macOS) keeps the old behaviour: a server tied to
   the terminal.

   Because the window can outlive the server either way, a service worker
   (`public/sw.js`) catches the failed navigation and serves
   `public/offline.html`: it names the port, gives the command to start the
   server, points at `brew services` for the permanent fix, and reloads
   itself once `/api/health` answers. Editing that page means bumping the
   `CACHE` constant in `sw.js`, or installed browsers keep the old copy.

3. **The `differ` CLI.** From any checkout, `differ` hands the repo to the
   running server (`/api/open`) and raises a window. The app window collects
   the handoff on load and on every focus — so the flow is: `differ` in a
   terminal, Cmd-Tab to the differ window, and it's showing that repo.

## Local (unpackaged) equivalent

From a checkout of this repo:

```bash
npm ci && npm run build      # assembles .next/standalone via postbuild
npm link                     # puts `differ` on PATH
differ                       # from any repo
```

Then install the window from the browser as above. This is the full
experience, launchd included — the agent points at this checkout's
`.next/standalone`, and the next `differ` after an `npm run build` restarts it
onto the new build.

## Publishing the Homebrew formula

See the comment block in `homebrew/differ.rb`. Short version: tag a release,
attach a tarball containing `standalone/` and `bin/differ.mjs`, fill in
`url` + `sha256`, and push the formula to a `homebrew-differ` tap repo.

## PATH and launchd

launchd services don't inherit a login shell's PATH, so a service-started
differ would not find `gh` in `/opt/homebrew/bin`. Two layers handle this:

- the formula's `service` block sets PATH explicitly, and
- the server itself appends `/opt/homebrew/bin` and `/usr/local/bin` to PATH
  at startup (`lib/exec.ts`) if they exist and are missing.

So even a bare `node standalone/server.js` under launchd finds git and gh.

## Ports

Default is **4460** (`DIFFER_PORT` or `--port` to override). The CLI probes
`/api/health` before reusing a port, so an unrelated server on 4460 is
detected rather than hijacked; the health endpoint identifies the app.

## Security posture

The server binds `127.0.0.1` in every mode — CLI, service, and formula all
set `HOSTNAME=127.0.0.1`. It executes `git` against arbitrary local paths on
request, so it must never be reachable from the network.
