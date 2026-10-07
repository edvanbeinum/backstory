# Packaging differ

differ ships as a Mac app that runs its own server; the README's "Running it
as an app" says how to build it.

## The Homebrew formula

`homebrew/differ.rb` is a skeleton from before the Mac app, and stale against
the CLI: it installs `bin/` beside a standalone build and runs the server as a
`brew services` agent. A formula or cask channel is a later issue. Short
version of publishing one: tag a release, attach a tarball, fill in `url` +
`sha256`, and push the formula to a `homebrew-differ` tap repo.

## Ports

Default is **4460** (`DIFFER_PORT` or `--port` to override). The app and the
CLI probe `/api/health` before using a port, so an unrelated server on 4460
is detected rather than hijacked; the health endpoint identifies the app.

## Security posture

The server binds `127.0.0.1` in every mode — the Mac app and the formula set
`HOSTNAME=127.0.0.1`, and `npm run dev` and `npm start` pass `-H 127.0.0.1`.
It executes `git` against arbitrary local paths on request, so it must never
be reachable from the network.
