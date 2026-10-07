#!/usr/bin/env bash
# Builds mac/build/differ.app from the Xcode project, with differ's icon,
# package.json's version, and the standalone server and a Node to run it in
# the bundle. Run `npm run build` first; `npm run mac:build` does. It runs on
# the machine that built it; it isn't signed for anyone else's.
set -euo pipefail
cd "$(dirname "$0")/.."

out=mac/build
app="$out/differ.app"
standalone=.next/standalone
version="$(node -p 'require("./package.json").version')"
node="$(node -p 'process.execPath')"

if [ ! -f "$standalone/server.js" ]; then
  echo "mac:build: no $standalone/server.js — run npm run build first" >&2
  exit 1
fi
if ! lipo "$node" -verify_arch arm64 2>/dev/null; then
  echo "mac:build: $node isn't an arm64 Node" >&2
  exit 1
fi

xcodebuild -quiet -project mac/differ/differ.xcodeproj -scheme differ \
  -configuration Release -derivedDataPath "$out/DerivedData" \
  MARKETING_VERSION="$version" build

rm -rf "$app"
ditto "$out/DerivedData/Build/Products/Release/differ.app" "$app"
identity="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"

# Copy an allowlist, never the whole folder: `lib/exec.ts` makes Next trace
# the project, so the standalone output also holds the sources, tests and
# docs. sharp is left out because `images.unoptimized` means the server never
# loads it, and its native libraries would each need signing.
server="$app/Contents/Resources/server"
mkdir -p "$server"
for item in server.js .next node_modules public package.json; do
  rsync -a --exclude 'node_modules/sharp' --exclude 'node_modules/@img' \
    "$standalone/$item" "$server/"
done
cp mac/server-exit-with-parent.cjs "$app/Contents/Resources/"

mkdir -p "$app/Contents/Helpers"
cp "$node" "$app/Contents/Helpers/node"

iconset="$out/differ.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/icon-512.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  if [ $((size * 2)) -le 512 ]; then
    sips -z $((size * 2)) $((size * 2)) public/icon-512.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/differ.icns"

plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string differ" "$plist"

# Sign Node first, with the JIT entitlements V8 can't run without under the
# hardened runtime, then the app, with the identity Xcode used (ad hoc when it
# used none). The app's signature has to be last because adding the server,
# Node and the icon broke Xcode's, and it must not re-sign Node (no --deep), or
# Node loses its entitlements and the server crashes at once.
codesign --force --options runtime --entitlements mac/node.entitlements \
  --sign "${identity:--}" "$app/Contents/Helpers/node"
codesign --force --options runtime --preserve-metadata=entitlements \
  --sign "${identity:--}" "$app"

echo "built $app ($version, $(du -sh "$app" | cut -f1))"
