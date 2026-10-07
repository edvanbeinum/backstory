# Packaging differ

differ ships as a Mac app that runs its own server; the README's "Running it
as an app" says how to build it.

## Signing and notarization

`npm run mac:build` signs the app with a Developer ID Application certificate
when the keychain has one, so Gatekeeper accepts it on other Macs. Without
one it falls back to the identity Xcode used, which only this Mac trusts; the
build prints which it used. It bundles the `node` it runs with, which must be
a standalone arm64 build (nvm's, not Homebrew's).

`npm run mac:dmg` packs the built app into `mac/build/differ-<version>.dmg`,
signs it, and with a notary profile set, notarizes and staples it and runs
Gatekeeper's checks on it and on the app inside. That DMG is what a release
attaches.

Once, on the Mac that builds releases:

1. Create a Developer ID Application certificate in your Apple Developer
   account and install it in the login keychain.
2. Store an App Store Connect API key as a notary profile:

   ```bash
   xcrun notarytool store-credentials backstory --key <path to .p8> --key-id <key id> --issuer <issuer id>
   ```

Then:

```bash
DIFFER_NOTARY_PROFILE=backstory npm run mac:dmg
```

`DIFFER_SIGN_IDENTITY` picks a signing identity by name when the keychain has
more than one. Without `DIFFER_NOTARY_PROFILE`, `mac:dmg` still builds and
signs the DMG but says it isn't notarized.

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
