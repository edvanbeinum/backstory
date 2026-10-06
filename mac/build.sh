#!/usr/bin/env bash
# Builds mac/build/differ.app from the Xcode project, with differ's icon and
# package.json's version. It runs on the machine that built it; it isn't
# signed for anyone else's.
set -euo pipefail
cd "$(dirname "$0")/.."

out=mac/build
app="$out/differ.app"
version="$(node -p 'require("./package.json").version')"

xcodebuild -quiet -project mac/differ/differ.xcodeproj -scheme differ \
  -configuration Release -derivedDataPath "$out/DerivedData" \
  MARKETING_VERSION="$version" build

rm -rf "$app"
ditto "$out/DerivedData/Build/Products/Release/differ.app" "$app"

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

# Adding the icon breaks Xcode's signature, so sign again with the identity
# Xcode used, or ad hoc when it used none.
identity="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
codesign --force --options runtime --preserve-metadata=entitlements \
  --sign "${identity:--}" "$app"

echo "built $app ($version)"
