#!/usr/bin/env bash
# Boots the emulator if needed, installs the Debug APK, forwards the dev server and object store ports, and launches the app.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
AVD="${AVD:-Pixel_9_API_36}"
if ! adb get-state >/dev/null 2>&1; then
    nohup emulator -avd "$AVD" -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
    adb wait-for-device
    until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
fi
adb install -r "$DIR/app/build/outputs/apk/debug/app-debug.apk"
# localhost on the emulator reaches the host's web dev server and MinIO.
adb reverse tcp:5173 tcp:5173
adb reverse tcp:9000 tcp:9000
adb shell am start -n com.hushos.app/.MainActivity
