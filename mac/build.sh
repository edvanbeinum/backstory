#!/usr/bin/env bash
# Builds mac/build/Backstory.app from the Xcode project, with Backstory's
# icon, package.json's version, and the standalone server and the Node pinned
# below to run it in the bundle. Run `npm run build` first; `npm run
# mac:build` does. It signs with BACKSTORY_SIGN_IDENTITY, else a Developer ID
# Application certificate in the keychain, else the identity Xcode used,
# which Gatekeeper rejects on any other Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

out=mac/build
app="$out/Backstory.app"
standalone=.next/standalone
version="$(node -p 'require("./package.json").version')"

# Bundle this Node from nodejs.org rather than the one running the build, so
# every build ships the same standalone binary: a Homebrew Node loads a
# shared libnode the bundle doesn't carry, and dies at launch. To bump it,
# take the new sum from https://nodejs.org/dist/v<version>/SHASUMS256.txt.
node_version=22.23.3
node_sha256=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53
node_tar="node-v$node_version-darwin-arm64.tar.gz"
node="$out/node-v$node_version"

if [ ! -f "$standalone/server.js" ]; then
  echo "mac:build: no $standalone/server.js — run npm run build first" >&2
  exit 1
fi
if [ ! -x "$node" ]; then
  mkdir -p "$out"
  curl -fsSL "https://nodejs.org/dist/v$node_version/$node_tar" -o "$out/$node_tar"
  echo "$node_sha256  $out/$node_tar" | shasum -a 256 -c --quiet
  tar -xzf "$out/$node_tar" -C "$out" --strip-components 2 "${node_tar%.tar.gz}/bin/node"
  mv "$out/node" "$node"
  rm "$out/$node_tar"
fi

# Build unsigned: the project's automatic signing wants a development
# certificate, which a release runner doesn't have, and everything is signed
# below anyway.
xcodebuild -quiet -project mac/backstory/Backstory.xcodeproj -scheme Backstory \
  -configuration Release -derivedDataPath "$out/DerivedData" \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$version" \
  CODE_SIGNING_ALLOWED=NO build

rm -rf "$app"
ditto "$out/DerivedData/Build/Products/Release/Backstory.app" "$app"
# Stamp the bundle with this build's time. ditto keeps the date Xcode's
# incremental build left on the folder, so Finder would show an old build date.
touch "$app"
identity="${BACKSTORY_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning |
    sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -1)"
fi
identity="${identity:--}"
# Ask Apple's server for a secure timestamp, which notarization requires,
# unless the build is ad hoc: that one never leaves this Mac.
timestamp=--timestamp
[ "$identity" = - ] && timestamp=--timestamp=none

# Copy an allowlist, never the whole folder: `lib/exec.ts` makes Next trace
# the project, so the standalone output also holds the sources, tests and
# docs. sharp is left out because `images.unoptimized` means the server never
# loads it, and its native libraries would each need signing. The store makes
# a new database from lib/schema.sql and upgrades an old one from
# lib/upgrades/; copying them from the standalone output fails the build if
# the standalone output ever lacks them.
server="$app/Contents/Resources/server"
mkdir -p "$server/lib"
for item in server.js .next node_modules public package.json; do
  rsync -a --exclude 'node_modules/sharp' --exclude 'node_modules/@img' \
    "$standalone/$item" "$server/"
done
cp "$standalone/lib/schema.sql" "$server/lib/schema.sql"
cp -R "$standalone/lib/upgrades" "$server/lib/"
cp mac/server-exit-with-parent.cjs "$app/Contents/Resources/"

# The `backstory` command, which the Claude Code hook runs by its path in
# here. The template sits at ../packaging/claude/ from bin/, as in a checkout.
bin="$app/Contents/Resources/bin"
mkdir -p "$bin" "$app/Contents/Resources/packaging/claude"
cp bin/backstory.mjs bin/hook.mjs bin/macapp.mjs bin/claude-setup.mjs "$bin/"
install -m 755 mac/bin/backstory "$bin/backstory"
cp packaging/claude/backstory-review.md "$app/Contents/Resources/packaging/claude/"

mkdir -p "$app/Contents/Helpers"
cp "$node" "$app/Contents/Helpers/node"

iconset="$out/Backstory.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/icon-512.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  if [ $((size * 2)) -le 512 ]; then
    sips -z $((size * 2)) $((size * 2)) public/icon-512.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Backstory.icns"

plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string Backstory" "$plist"

# Sign Node first, with the JIT entitlements V8 can't run without under the
# hardened runtime, then the app. The app's signature has to be last, and it
# must not re-sign Node (no --deep), or Node loses its entitlements and the
# server crashes at once. The app needs no entitlements.
codesign --force --options runtime "$timestamp" \
  --entitlements mac/node.entitlements \
  --sign "$identity" "$app/Contents/Helpers/node"
# Re-sign Sparkle's nested code, inside out, as its notarization guide says:
# Xcode embeds it signed ad hoc or with its own identity and no timestamp,
# which notarization refuses. The Downloader keeps its sandbox entitlements.
sparkle="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
codesign --force --options runtime "$timestamp" --sign "$identity" \
  "$sparkle/XPCServices/Installer.xpc"
codesign --force --options runtime "$timestamp" --sign "$identity" \
  --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
codesign --force --options runtime "$timestamp" --sign "$identity" "$sparkle/Autoupdate"
codesign --force --options runtime "$timestamp" --sign "$identity" "$sparkle/Updater.app"
codesign --force --options runtime "$timestamp" --sign "$identity" \
  "$app/Contents/Frameworks/Sparkle.framework"
codesign --force --options runtime "$timestamp" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"

echo "built $app ($version, $(du -sh "$app" | cut -f1))"
echo "signed with $identity"
