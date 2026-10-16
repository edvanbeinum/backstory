# Packaging Backstory

Backstory ships as a Mac app that runs its own server;
[Working on Backstory](../docs/contributing.md) says how to build it.

## Signing and notarization

`npm run mac:build` signs the app with a Developer ID Application certificate
when the keychain has one, so Gatekeeper accepts it on other Macs. Without
one it falls back to the identity Xcode used, which only this Mac trusts; the
build prints which it used. The Node in the bundle is the version pinned in
`mac/build.sh`, downloaded from nodejs.org on the first build and checked
against its published checksum, whatever `node` ran the build.

`npm run mac:dmg` packs the built app into `mac/build/Backstory-<version>.dmg`,
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
BACKSTORY_NOTARY_PROFILE=backstory npm run mac:dmg
```

`BACKSTORY_SIGN_IDENTITY` picks a signing identity by name when the keychain
has more than one. Without `BACKSTORY_NOTARY_PROFILE`, `mac:dmg` still builds
and signs the DMG but says it isn't notarized.

## Releasing

A release is a version tag. `.github/workflows/release.yml` runs on any `v*`
tag on a macOS runner: `npm run verify`, `mac:build`, `mac:dmg` with the
`backstory` notary profile, `mac:appcast`, `mac:smoke`, then a GitHub release
marked latest with `Backstory-<version>.dmg` and `appcast.xml`. The app's
**Check for Updates…** reads
`https://github.com/edvanbeinum/backstory/releases/latest/download/appcast.xml`,
so each release offers itself to every installed copy. That address answers
only once the repository is public.

`npm run mac:appcast` writes `mac/build/appcast.xml` for the DMG `mac:dmg`
made, with one item signed by the Sparkle key. It fetches Sparkle's
`generate_appcast` and `sign_update`, pinned in `mac/appcast.sh` to the
version the app links, and takes the key from `SPARKLE_PRIVATE_KEY_FILE`, else
the login keychain.

Once:

1. Make the Sparkle key pair with `generate_keys` from Sparkle's tools
   (`mac/build/sparkle-2.10.0/bin/` after a `mac:appcast`). It keeps the
   private key in the login keychain and prints the public key, which goes in
   `SUPublicEDKey` in `mac/backstory/Backstory/Info.plist`. A lost private key
   means installed copies can't take another update, so keep a copy:

   ```bash
   mac/build/sparkle-2.10.0/bin/generate_keys -x sparkle-private-key
   ```

2. Add these repository secrets on GitHub:
   - `MAC_CERT_P12`: the Developer ID Application certificate and its key,
     exported from Keychain Access as a `.p12`, then `base64 -i cert.p12`
   - `MAC_CERT_PASSWORD`: the password the `.p12` was exported with
   - `NOTARY_KEY`: the contents of the App Store Connect API key's `.p8`
   - `NOTARY_KEY_ID` and `NOTARY_ISSUER`: that key's ID and issuer ID
   - `SPARKLE_PRIVATE_KEY`: the contents of `sparkle-private-key`

Raise the minor version for a release with a change people would notice, such
as a new feature or a redesign. Raise the patch version for anything else:
fixes, a new icon, dependency updates.

Then, for each release:

1. Bump the version on a branch and merge it through a pull request, since
   `main` takes no direct pushes. Use `minor` in place of `patch` for a minor
   release:

   ```bash
   npm version patch --no-git-tag-version
   ```

2. Tag the merged commit and push the tag. The tag's message becomes the
   release notes:

   ```bash
   git fetch origin && git tag -a v<version> origin/main
   ```

   ```bash
   git push origin v<version>
   ```

The workflow stops if the tag doesn't match `package.json`'s version.

When notarization fails, the `mac:dmg` step prints `notarytool log` with
Apple's reasons. A failed run publishes nothing, so merge a fix, delete the
tag locally and on GitHub, and tag the new merge commit.

## Dependency updates

Dependabot opens a pull request once a week when a dependency has a new
version, from `.github/dependabot.yml`: one for `next` and `eslint-config-next`
together, one for the other npm packages' patch and minor updates, one for the
GitHub Actions the workflows use, and one for Sparkle. A security update comes
as soon as an advisory is published. Each pull request runs `check`, and
`.github/workflows/dependabot-merge.yml` merges a patch or minor update once
`check` passes. A major update, or one that fails `check`, waits in the pull
request list for a person. A merge changes nothing installed: updates reach the
app at the next release.

A Sparkle pull request needs one change by hand before it merges. On its
branch, set `sparkle_version` and `sparkle_sha256` in `mac/appcast.sh` to the
new version and the `checksum` in Sparkle's `Package.swift` at that tag, so the
tools that sign the appcast match the framework the app links. The pull
request is a major or minor update, so it waits for that change.

The Node the app bundles is pinned in `mac/build.sh` with its checksum. To
bump it, set `node_version` and take `node_sha256` from
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`.

## Ports

Default is **4460** (`BACKSTORY_PORT` or `--port` to override). The app and the
CLI probe `/api/health` before using a port, so an unrelated server on 4460
is detected rather than hijacked; the health endpoint identifies the app.

## Security posture

The server binds `127.0.0.1` in every mode — the Mac app sets
`HOSTNAME=127.0.0.1`, and `npm run dev` and `npm start` pass `-H 127.0.0.1`.
It executes `git` against arbitrary local paths on request, so it must never
be reachable from the network.
