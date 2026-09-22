#!/usr/bin/env bash
# Installs the Debug build on the iOS simulator and launches it. Set SIMULATOR to a device UDID or name.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
DEVICE="${SIMULATOR:-iPhone 18 Pro}"
xcrun simctl boot "$DEVICE" 2>/dev/null || true
open -a Simulator 2>/dev/null || true
xcrun simctl install "$DEVICE" "$DIR/DerivedData/Build/Products/Debug-iphonesimulator/HushOS.app"
xcrun simctl launch "$DEVICE" com.hushos.app
