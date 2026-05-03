#!/usr/bin/env bash
set -euo pipefail

# Build/sign/notarize the macOS Apple Silicon release artifacts.
#
# Required:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE="murmur-notary"   # created by xcrun notarytool store-credentials
#
# Optional:
#   VERSION=0.2.6
#   SKIP_BUILD=1
#
# Run from the repository root:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." \
#   NOTARY_PROFILE="murmur-notary" \
#   ./scripts/macos-notarize-release.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app"
VERSION="${VERSION:-$(node -p "require('$APP_DIR/package.json').version")}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
APP="$APP_DIR/src-tauri/target/release/bundle/macos/Murmur.app"
MACOS_BUNDLE_DIR="$APP_DIR/src-tauri/target/release/bundle/macos"
DMG_DIR="$APP_DIR/src-tauri/target/release/bundle/dmg"
ZIP="$MACOS_BUNDLE_DIR/Murmur_${VERSION}_aarch64.app.zip"
DMG="$DMG_DIR/Murmur_${VERSION}_aarch64.dmg"

if [[ -z "$IDENTITY" ]]; then
  echo "APPLE_SIGNING_IDENTITY is required." >&2
  echo 'Example: export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"' >&2
  exit 2
fi

if [[ -z "$NOTARY_PROFILE" ]]; then
  echo "NOTARY_PROFILE is required." >&2
  echo 'Create it first: xcrun notarytool store-credentials murmur-notary --apple-id ... --team-id ... --password ...' >&2
  exit 2
fi

echo "== Murmur macOS notarized release =="
echo "root     : $ROOT"
echo "version  : $VERSION"
echo "identity : $IDENTITY"
echo "profile  : $NOTARY_PROFILE"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "== Build Tauri app bundle =="
  (cd "$APP_DIR" && npm run tauri:build)
fi

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found: $APP" >&2
  exit 1
fi

echo "== Remove local extended attributes =="
xattr -cr "$APP" || true

echo "== Sign nested Mach-O files =="
while IFS= read -r -d '' f; do
  kind="$(file -b "$f" || true)"
  case "$kind" in
    *"Mach-O"*)
      echo "sign nested: ${f#$ROOT/}"
      codesign --force --options runtime --timestamp --sign "$IDENTITY" "$f"
      ;;
  esac
done < <(find "$APP" -type f -print0)

echo "== Sign app bundle =="
codesign --force --options runtime --timestamp --deep --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "== Create zip and dmg =="
mkdir -p "$DMG_DIR"
rm -f "$ZIP" "$DMG"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "== Submit app zip to Apple notarization =="
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

echo "== Staple and validate app ticket =="
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"

echo "== Recreate zip with stapled app =="
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

hdiutil create -volname Murmur -srcfolder "$APP" -ov -format UDZO "$DMG"

echo "== Sign dmg =="
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
codesign --verify --verbose=2 "$DMG"
hdiutil verify "$DMG"

echo "== Submit dmg to Apple notarization =="
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "== Staple and validate ticket =="
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

echo "== SHA256 =="
shasum -a 256 "$ZIP" "$DMG"

cat <<EOF

Done.
Artifacts:
  $ZIP
  $DMG

Upload:
  gh release upload v$VERSION "$ZIP" "$DMG" --clobber
EOF
