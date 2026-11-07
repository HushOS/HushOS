#!/usr/bin/env bash
# Archives HushOS for the App Store and uploads it to App Store Connect (TestFlight first).
#
#   DEVELOPMENT_TEAM=ABCDE12345 apps/ios/scripts/archive.sh
#
# The version people see (CFBundleShortVersionString) is the product version: the root
# package.json, which the release pull request also writes into project.yml's MARKETING_VERSION
# (bun run check:versions holds them together). The build number (CFBundleVersion) is
# scripts/build-number.sh, the commit count on main, passed to xcodebuild for the app and its
# four extensions alike; nothing is edited or committed. Archive from main, best at a release
# tag (git checkout v1.2.3). Needs Xcode signed in (Settings > Accounts) to the Apple Account
# that is Account Holder or Admin on the team; signing is automatic.
# UPLOAD=0 stops after the archive and export, leaving the .ipa in apps/ios/build/export.
#
# On a machine with no Apple Account in Xcode (ios-release.yml), an App Store Connect API key
# signs in instead: ASC_KEY_PATH (the .p8 file), ASC_KEY_ID and ASC_ISSUER_ID. The key's role
# must be Admin, so that Xcode may create the distribution certificate and profiles itself
# (cloud-managed); nothing about signing is kept on the machine.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
: "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to the 10-character Team ID (developer.apple.com/account, Membership details)}"
[[ "$DEVELOPMENT_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo "The Team ID is 10 capital letters and digits" >&2; exit 1; }
AUTH=()
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
    : "${ASC_KEY_ID:?Set ASC_KEY_ID with ASC_KEY_PATH}" "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID with ASC_KEY_PATH}"
    AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
[[ $# -eq 0 ]] || { echo "archive.sh takes no arguments: the version is package.json's, the build number scripts/build-number.sh's" >&2; exit 1; }

# Every copy of the version agrees with package.json, or nothing is archived.
(cd ../.. && bun scripts/check-versions.ts)
VERSION=$(cd ../.. && bun -p 'require("./package.json").version')
BUILD=$(../../scripts/build-number.sh --store)
echo "Archiving HushOS $VERSION ($BUILD)"

[[ -d Packages/HushOSCore/HushOSCoreFFI.xcframework ]] || (cd ../.. && bun run core:apple)
xcodegen generate --quiet

ARCHIVE="$DIR/build/HushOS.xcarchive"
EXPORT="$DIR/build/export"
rm -rf "$ARCHIVE" "$EXPORT"
xcodebuild -project HushOS.xcodeproj -scheme HushOS -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
    -skipPackagePluginValidation -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$BUILD" archive

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
    -exportOptionsPlist "$OPTIONS" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}
rm -f "$OPTIONS"
if [[ "$DESTINATION" == upload ]]; then
    echo "Uploaded $VERSION ($BUILD). It appears in App Store Connect > TestFlight after processing (usually 5-30 minutes)."
else
    echo "Exported to $EXPORT"
fi
