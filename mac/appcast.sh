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

# Fetch Sparkle's tools from the zip its Swift package resolves to, checked
# against the sum in Sparkle's own Package.swift, so they match the framework
# in the app. To bump it, take `checksum` from Package.swift at the new tag.
sparkle_version=2.10.0
sparkle_sha256=17e28312b8e18ab7cdbbe09a6fb28cc55a5479ec6c371dbc07cdecd2a14fd959
sparkle_zip="$out/Sparkle-$sparkle_version.zip"
tools="$out/sparkle-$sparkle_version"

if [ ! -f "$dmg" ]; then
  echo "mac:appcast: no $dmg — run npm run mac:dmg first" >&2
  exit 1
fi
if [ ! -x "$tools/bin/generate_appcast" ]; then
  curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/$sparkle_version/Sparkle-for-Swift-Package-Manager.zip" \
    -o "$sparkle_zip"
  echo "$sparkle_sha256  $sparkle_zip" | shasum -a 256 -c --quiet
  rm -rf "$tools"
  mkdir -p "$tools"
  unzip -q "$sparkle_zip" 'bin/*' -d "$tools"
  rm "$sparkle_zip"
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
