#!/bin/sh
# Builds HushOS for the iPhone plugged into this Mac and installs it.
# Needs Xcode signed in to an Apple Developer Program account (the app group and
# keychain sharing are not available to free accounts) and DEVELOPMENT_TEAM set,
# e.g. `DEVELOPMENT_TEAM=ABCDE12345 bun run ios:device`.
set -eu
cd "$(dirname "$0")/.."
: "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to your Apple team id (Xcode > Settings > Accounts)}"
DEVICE=$(xcrun devicectl list devices --hide-headers 2>/dev/null | grep physical | grep -w connected | grep -oE '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)
: "${DEVICE:?No iPhone connected. Plug it in, unlock it, and trust this Mac}"
xcodebuild -project HushOS.xcodeproj -scheme HushOS -configuration Debug \
    -destination "id=$DEVICE" -derivedDataPath DerivedData -skipPackagePluginValidation \
    -allowProvisioningUpdates DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" build
APP=$(find DerivedData/Build/Products/Debug-iphoneos -maxdepth 1 -name HushOS.app | head -1)
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" com.hushos.app
