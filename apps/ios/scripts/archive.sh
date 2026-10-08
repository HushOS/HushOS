#!/usr/bin/env bash
# Archives HushOS for the App Store and uploads it to App Store Connect (TestFlight first).
#
#   DEVELOPMENT_TEAM=ABCDE12345 apps/ios/scripts/archive.sh 0.1.0 2
#
# The two arguments are the version people see (CFBundleShortVersionString) and the build
# number (CFBundleVersion), written into all five targets in project.yml so they always match;
# every upload needs a build number higher than the last one for that version. Commit the
# project.yml change after a successful upload. Needs Xcode signed in (Settings > Accounts) to
# the Apple Account that is Account Holder or Admin on the team; signing is automatic.
# UPLOAD=0 stops after the archive and export, leaving the .ipa in apps/ios/build/export.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
VERSION="${1:?Usage: archive.sh <version, e.g. 0.1.0> <build number, e.g. 2>}"
BUILD="${2:?Usage: archive.sh <version, e.g. 0.1.0> <build number, e.g. 2>}"
: "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to the 10-character Team ID (developer.apple.com/account, Membership details)}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "The version must look like 1.0 or 1.0.0" >&2; exit 1; }
[[ "$BUILD" =~ ^[0-9]+$ ]] || { echo "The build number must be a whole number" >&2; exit 1; }
[[ "$DEVELOPMENT_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo "The Team ID is 10 capital letters and digits" >&2; exit 1; }

# One version and one build number for the app and its four extensions (App Store Connect
# refuses an upload whose extensions disagree with the app).
sed -i '' -E "s/(CFBundleShortVersionString: )'[^']*'/\1'$VERSION'/; s/(CFBundleVersion: )'[^']*'/\1'$BUILD'/" project.yml
echo "project.yml: $(grep -c "CFBundleVersion: '$BUILD'" project.yml) targets at $VERSION ($BUILD)"

[[ -d Packages/HushOSCore/HushOSCoreFFI.xcframework ]] || (cd ../.. && bun run core:apple)
xcodegen generate --quiet

ARCHIVE="$DIR/build/HushOS.xcarchive"
EXPORT="$DIR/build/export"
rm -rf "$ARCHIVE" "$EXPORT"
xcodebuild -project HushOS.xcodeproj -scheme HushOS -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
    -skipPackagePluginValidation -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" archive

# The simulator-only File Provider testing mode must never reach a store build.
if codesign -d --entitlements :- "$ARCHIVE/Products/Applications/HushOS.app" 2>/dev/null | grep -q fileprovider.testing-mode; then
    echo "The archive carries the File Provider testing-mode entitlement; stop and check App/HushOS.xcconfig" >&2
    exit 1
fi

OPTIONS=$(mktemp -t ExportOptions).plist
DESTINATION=$([[ "${UPLOAD:-1}" == 1 ]] && echo upload || echo export)
cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>$DESTINATION</string>
    <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
    <key>signingStyle</key><string>automatic</string>
    <key>manageAppVersionAndBuildNumber</key><false/>
    <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
    -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates
rm -f "$OPTIONS"
if [[ "$DESTINATION" == upload ]]; then
    echo "Uploaded $VERSION ($BUILD). It appears in App Store Connect > TestFlight after processing (usually 5-30 minutes)."
else
    echo "Exported to $EXPORT"
fi
