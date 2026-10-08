#!/usr/bin/env bash
# Packs mac/build/Backstory.app into mac/build/Backstory-<version>.dmg with an
# Applications link to drag it to, signed with the app's own identity. With
# BACKSTORY_NOTARY_PROFILE set to a `notarytool store-credentials` profile, it
# notarizes and staples the DMG, then runs Gatekeeper's checks on it and on
# the app inside, which stand in for opening it on a clean Mac. Run
# `npm run mac:build` first; this doesn't rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

app=mac/build/Backstory.app
version="$(node -p 'require("./package.json").version')"
dmg="mac/build/Backstory-$version.dmg"
profile="${BACKSTORY_NOTARY_PROFILE:-}"

if [ ! -d "$app" ]; then
  echo "mac:dmg: no $app — run npm run mac:build first" >&2
  exit 1
fi

identity="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
identity="${identity:--}"
timestamp=--timestamp
[ "$identity" = - ] && timestamp=--timestamp=none

work="$(mktemp -d)"
mountpoint="$work/mount"
cleanup() {
  if [ -d "$mountpoint" ]; then hdiutil detach -quiet "$mountpoint" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir "$work/stage"
ditto "$app" "$work/stage/Backstory.app"
ln -s /Applications "$work/stage/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname Backstory -srcfolder "$work/stage" -format UDZO "$dmg"
codesign --force "$timestamp" --sign "$identity" "$dmg"
codesign --verify --deep --strict "$dmg"
echo "signed $dmg with $identity"

if [ -z "$profile" ]; then
  echo "mac:dmg: not notarized: set BACKSTORY_NOTARY_PROFILE"
  exit 0
fi

# `submit --wait` exits 0 for a rejected submission too, so read its status.
result="$(xcrun notarytool submit "$dmg" --keychain-profile "$profile" \
  --wait --output-format json)"
read -r id status < <(node -e \
  'const r = JSON.parse(process.argv[1]); console.log(r.id, r.status)' "$result")
echo "notarization $id: $status"
if [ "$status" != Accepted ]; then
  xcrun notarytool log "$id" --keychain-profile "$profile" >&2
  exit 1
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature -v "$dmg"

mkdir "$mountpoint"
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mountpoint" "$dmg"
spctl --assess --type execute -v "$mountpoint/Backstory.app"
codesign --verify --deep --strict "$mountpoint/Backstory.app"

echo "built $dmg: notarized, stapled and accepted by Gatekeeper"
