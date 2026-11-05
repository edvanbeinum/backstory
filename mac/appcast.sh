#!/usr/bin/env bash
# Writes mac/build/appcast.xml, the Sparkle feed that offers
# mac/build/Backstory-<version>.dmg from this version's GitHub release. It
# signs the item with the EdDSA key in SPARKLE_PRIVATE_KEY_FILE, else the one
# `generate_keys` put in the login keychain. Run `npm run mac:dmg` first; this
# doesn't rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

out=mac/build
version="$(node -p 'require("./package.json").version')"
dmg="$out/Backstory-$version.dmg"
download="https://github.com/edvanbeinum/backstory/releases/download/v$version/"
# Use the Sparkle tools Xcode resolved for mac:build, so they're always the
# version the app links: Package.resolved pins it and Xcode checks the zip's
# checksum. The path is Xcode's package cache layout, which Apple doesn't
# document, so an Xcode update could move it.
tools="$out/DerivedData/SourcePackages/artifacts/sparkle/Sparkle"

if [ ! -f "$dmg" ]; then
  echo "mac:appcast: no $dmg — run npm run mac:dmg first" >&2
  exit 1
fi
if [ ! -x "$tools/bin/generate_appcast" ]; then
  echo "mac:appcast: no $tools/bin/generate_appcast — run npm run mac:build first" >&2
  exit 1
fi

key=()
if [ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ]; then
  key=(--ed-key-file "$SPARKLE_PRIVATE_KEY_FILE")
fi

# Give generate_appcast a folder holding only this DMG and no feed to start
# from: it makes an item for every archive it finds and keeps every item
# already in the feed, and mac/build keeps earlier versions of both.
rm -f "$out/appcast.xml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$dmg" "$work/"
"$tools/bin/generate_appcast" ${key[@]+"${key[@]}"} --download-url-prefix "$download" \
  -o "$out/appcast.xml" "$work"

echo "wrote $out/appcast.xml for Backstory $version"
