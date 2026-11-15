#!/usr/bin/env bash
# Build the iOS app and upload it to App Store Connect (TestFlight).
#
#   ios/release.sh            archive and upload
#   ios/release.sh --no-upload  archive and export only (build/Quisk.ipa)
#
# Signing and upload use either an App Store Connect API key or the Apple account signed in to Xcode:
#   ASC_KEY_ID, ASC_ISSUER_ID   from App Store Connect → Users and Access → Integrations → App Store Connect API
#   ASC_KEY_PATH                the AuthKey_<id>.p8 file (default: ~/.appstoreconnect/private_keys/AuthKey_<id>.p8,
#                               then ~/Downloads/AuthKey_<id>.p8)
# Each value is read from the environment, then ~/.env. Without a key ID and issuer ID, Xcode's account is used.
# The build number is the git commit count, so every upload from a new commit is accepted.
set -euo pipefail
cd "$(dirname "$0")"

get() { { grep -E "^$1=" ~/.env 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -E "s/^['\"]//; s/['\"]$//"; }
ASC_KEY_ID="${ASC_KEY_ID:-$(get ASC_KEY_ID)}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-$(get ASC_ISSUER_ID)}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$(get ASC_KEY_PATH)}"
if [ -n "$ASC_KEY_ID" ] && [ -z "$ASC_KEY_PATH" ]; then
  for p in ~/.appstoreconnect/private_keys/AuthKey_"$ASC_KEY_ID".p8 ~/Downloads/AuthKey_"$ASC_KEY_ID".p8; do
    [ -f "$p" ] && ASC_KEY_PATH="$p" && break
  done
fi
auth=(-allowProvisioningUpdates)
if [ -n "$ASC_KEY_ID" ] && [ -n "$ASC_ISSUER_ID" ] && [ -f "$ASC_KEY_PATH" ]; then
  auth+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  echo "Signing and uploading with App Store Connect API key $ASC_KEY_ID"
else
  echo "Signing and uploading with the Apple account signed in to Xcode"
fi

# The voice model ships in the app; fetch it once.
[ -f Quisk/Voice/tiny-voca.onnx ] || ../scripts/fetch-voice-model.sh
xcodegen generate -q

build="$(git rev-list --count HEAD)"
team="$(grep -m1 DEVELOPMENT_TEAM project.yml | awk '{print $2}')"
out=build
rm -rf "$out" && mkdir -p "$out"

echo "Archiving build $build"
xcodebuild -project Quisk.xcodeproj -scheme Quisk -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/Quisk.xcarchive" CURRENT_PROJECT_VERSION="$build" "${auth[@]}" archive -quiet

destination=upload
[ "${1:-}" = "--no-upload" ] && destination=export
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

echo "$( [ "$destination" = upload ] && echo Uploading || echo Exporting ) build $build"
xcodebuild -exportArchive -archivePath "$out/Quisk.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out" "${auth[@]}" -quiet

if [ "$destination" = upload ]; then
  echo "Uploaded build $build. It appears in TestFlight after Apple finishes processing (usually 5 to 15 minutes)."
else
  echo "Exported $out/Quisk.ipa"
fi
