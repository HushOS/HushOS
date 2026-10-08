#!/usr/bin/env bash
# The phone pictures on the site (home page, the 1.0 post, About): Home and the Lisbon 2026
# folder from the iPhone and Android debug apps, light and dark, at the three scales the site
# serves (apps/web/src/components/screenshot.tsx, `Phones`).
#
#   SCREENSHOTS=1 bunx playwright test e2e/screenshots.spec.ts --project=chromium   # the demo account
#   bun dev                                   # the debug apps talk to http://localhost:5173
#   scripts/site-phone-shots.sh ios           # or: android, or both (the default)
#
# Its own devices, never the ones you develop on: an iPhone 18 Pro simulator ("HushOS Site 6.3",
# 402x874 pt, captured at 3x) and a Pixel 8 Pro emulator ("HushOS_Site", 448x997 dp at 3x, on
# port 5562). It asks you to sign in once per device (the password goes on the clipboard, never on
# screen), then takes every picture itself. Times read mid-morning (e2e/morning-zone.ts).
# Output: apps/web/src/screenshots/{ios,android}-{home,folder}[-dark][@1.5x|@1x].png.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
WHICH="${1:-both}"
OUT="$ROOT/apps/web/src/screenshots"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
password() { sed -n "s/^export const PASSWORD = '\(.*\)';$/\1/p" e2e/helpers.ts | tr -d '\n'; }

curl -s -o /dev/null --max-time 5 http://localhost:5173/ || fail "Start the web dev server first (bun dev)."
command -v magick >/dev/null || fail "Needs ImageMagick (brew install imagemagick) to make the 2x, 1.5x and 1x pictures."
db() { docker exec hushos-db-1 psql -U hushos -d hushos -Atc "$1"; }
DEMO_EMAIL="${DEMO_EMAIL:-$(db "select email from users where email like 'maya.lindqvist@%' order by created_at desc limit 1" 2>/dev/null || true)}"
[[ -n "$DEMO_EMAIL" ]] || fail "No demo account: run the screenshot spec first (see the top of this file)."
# The Lisbon 2026 folder, by structure (names are encrypted): the account's folder of exactly twelve files.
LISBON=$(db "select f.id from drive_nodes f join users u on u.id = f.created_by
    where u.email = '$DEMO_EMAIL' and f.kind = 'folder' and f.trashed_at is null
    and (select count(*) from drive_nodes c where c.parent_id = f.id and c.trashed_at is null and c.kind = 'file') = 12
    and (select count(*) from drive_nodes c where c.parent_id = f.id and c.trashed_at is null) = 12 limit 1")
[[ -n "$LISBON" ]] || fail "Couldn't find the demo's Lisbon 2026 folder."
# Mid-morning when the demo account was made, so its files read "Today, 10:35".
ZONE=$(bun e2e/morning-zone.ts "$(db "select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from users where email = '$DEMO_EMAIL'")")

# Captures until two frames 1.5 s apart are the same, so no picture shows a spinner or a list still
# loading. Gives up after 30 s and keeps the last frame. `capture` writes one frame to the given file.
steady() { # file capture-command...
    local file="$1" previous="" current
    shift
    for _ in $(seq 1 20); do
        "$@" "$file"
        current=$(md5 -q "$file")
        [[ "$current" == "$previous" ]] && return
        previous="$current"
        sleep 1.5
    done
    printf '  (still changing after 30 s; check %s)\n' "$file"
}

# One capture at 3x becomes the site's three files: name.png (2x), name@1.5x.png and name@1x.png.
scales() { # capture name width2x height2x
    magick "$1" -alpha off -resize "${3}x${4}!" "$OUT/$2.png"
    magick "$1" -alpha off -resize "$(( $3 * 3 / 4 ))x$(( $4 * 3 / 4 ))!" "$OUT/$2@1.5x.png"
    magick "$1" -alpha off -resize "$(( $3 / 2 ))x$(( $4 / 2 ))!" "$OUT/$2@1x.png"
    printf '  saved %s (and @1.5x, @1x)\n' "${OUT#"$ROOT"/}/$2.png"
}

ios() {
    local name="HushOS Site 6.3" udid app="apps/ios/DerivedData/Build/Products/Debug-iphonesimulator/HushOS.app"
    udid=$(xcrun simctl list devices available | grep "$name (" | grep -oE '[0-9A-F-]{36}' | head -1 || true)
    if [[ -z "$udid" ]]; then
        local runtime
        runtime=$(xcrun simctl list runtimes available | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+' | tail -1)
        udid=$(xcrun simctl create "$name" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro "$runtime")
    fi
    [[ -d "$app" ]] || bun run ios:build
    xcrun simctl boot "$udid" 2>/dev/null || true
    xcrun simctl bootstatus "$udid" -b >/dev/null
    xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
        --cellularMode active --cellularBars 4 --operatorName "" --batteryState charged --batteryLevel 100
    xcrun simctl ui "$udid" appearance light
    xcrun simctl install "$udid" "$app"
    xcrun simctl terminate "$udid" com.hushos.app 2>/dev/null || true
    SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.hushos.app -AppleICUForce24HourTime NO >/dev/null
    say "iOS, on \"$name\" (open it in Simulator)."
    if [[ -z "${SIGNED_IN:-}" ]]; then
        password | xcrun simctl pbcopy "$udid"
        printf '  Sign in as %s if it isn'"'"'t already (the password is on its clipboard), dismiss any prompt, then press Enter. ' "$DEMO_EMAIL"
        read -r _
        printf '' | xcrun simctl pbcopy "$udid"
    fi
    # Every launch turns off a 24-hour override the simulator may carry (Settings › General ›
    # Date & Time), so times read "Today, 11:17 AM" as on the web and Android pictures.
    # Each picture is a fresh launch: Home is where the app opens, and the folder comes from a
    # debug-only launch argument, since `simctl openurl` makes iOS ask "Open in HushOS?" first.
    # The folder shows as a grid, as the browser beside it on the site does: `-files.view grid`
    # overrides the stored choice for that launch only.
    ios_frame() { xcrun simctl io "$udid" screenshot --type=png "$1" >/dev/null 2>&1; }
    shot() { # name [link]
        xcrun simctl terminate "$udid" com.hushos.app 2>/dev/null || true
        if [[ -n "${2:-}" ]]; then
            SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.hushos.app -AppleICUForce24HourTime NO -HushOSOpenLink "$2" -files.view grid >/dev/null
        else
            SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.hushos.app -AppleICUForce24HourTime NO >/dev/null
        fi
        sleep 2
        steady "$TMP/$1.png" ios_frame
        scales "$TMP/$1.png" "$1" 804 1748
    }
    for theme in light dark; do
        local suffix=""
        [[ "$theme" == dark ]] && suffix="-dark"
        xcrun simctl ui "$udid" appearance "$theme"
        sleep 2
        shot "ios-home$suffix"
        shot "ios-folder$suffix" "hushos://app/drive?folder=$LISBON"
    done
    xcrun simctl ui "$udid" appearance light
}

android() {
    local avd="HushOS_Site" serial="emulator-5562" apk="apps/android/app/build/outputs/apk/debug/app-debug.apk"
    if ! emulator -list-avds | grep -qx "$avd"; then
        echo "no" | avdmanager create avd -n "$avd" -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_8_pro >/dev/null
    fi
    [[ -f "$apk" ]] || bun run android:build
    if ! adb devices | grep -q "^$serial"; then
        nohup emulator -avd "$avd" -port 5562 -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
    fi
    local a="adb -s $serial"
    $a wait-for-device
    until [[ "$($a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done
    $a install -r "$apk" >/dev/null
    $a reverse tcp:5173 tcp:5173 >/dev/null
    $a reverse tcp:9000 tcp:9000 >/dev/null
    $a shell cmd alarm set-timezone "$ZONE" >/dev/null
    $a shell cmd uimode night no >/dev/null
    $a shell settings put global sysui_demo_allowed 1
    demo() { $a shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
    # A clean status bar. Sent again before every picture: a status bar that has just booted, or
    # restarted with the theme, drops it and shows the real time.
    status() {
        demo enter
        demo clock -e hhmm 0941
        demo network -e wifi show -e level 4 -e fully true
        demo network -e mobile hide
        demo battery -e level 100 -e plugged false
        demo notifications -e visible false
    }
    $a shell am start -n com.hushos.app/.MainActivity >/dev/null
    say "Android, on the $avd emulator."
    if [[ -z "${SIGNED_IN:-}" ]]; then
        printf '  Is the app already signed in as %s? [y/N] ' "$DEMO_EMAIL"
        read -r answer
        if [[ "$answer" != [yY]* ]]; then
            printf '  Tap the Email field, then press Enter here. '
            read -r _
            $a shell input text "$DEMO_EMAIL"
            printf '  Tap the Password field, then press Enter here (the script types it). '
            read -r _
            $a shell input text "$(password)"
            printf '  Tap Sign in, dismiss any prompt, wait for Home, then press Enter. '
            read -r _
        fi
    fi
    android_frame() { status; $a exec-out screencap -p > "$1"; }
    # The folder shows as a grid, as the browser beside it on the site does. The choice lives in the
    # app's "files" preferences; the debug build lets run-as edit them, and they're put back after.
    local prefs=shared_prefs/files.xml saved
    saved=$($a shell run-as com.hushos.app cat "$prefs" 2>/dev/null || true)
    set_view() { # list|grid
        local xml="${saved:-<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map></map>}"
        xml=$(printf '%s' "$xml" | tr -d '\r' | sed 's#<string name="files.view">[a-z]*</string>##')
        xml=${xml/<map>/<map><string name=\"files.view\">$1</string>}
        $a shell am force-stop com.hushos.app
        printf '%s' "$xml" | $a shell run-as com.hushos.app sh -c "'mkdir -p shared_prefs && cat > $prefs'"
    }
    for theme in no yes; do
        local suffix=""
        [[ "$theme" == yes ]] && suffix="-dark"
        $a shell cmd uimode night "$theme" >/dev/null
        sleep 2
        $a shell am start -W -a android.intent.action.VIEW -d "'hushos://app'" com.hushos.app >/dev/null
        sleep 2
        steady "$TMP/home.png" android_frame
        scales "$TMP/home.png" "android-home$suffix" 896 1995
        set_view grid
        $a shell am start -W -a android.intent.action.VIEW -d "'hushos://app/drive?folder=$LISBON'" com.hushos.app >/dev/null
        sleep 2
        steady "$TMP/folder.png" android_frame
        scales "$TMP/folder.png" "android-folder$suffix" 896 1995
        set_view list
    done
    $a shell cmd uimode night no >/dev/null
    demo exit
}

case "$WHICH" in
    ios) ios ;;
    android) android ;;
    both) ios; android ;;
    *) fail "Usage: scripts/site-phone-shots.sh [ios|android|both]" ;;
esac
say "Done. Check the pictures, then commit apps/web/src/screenshots."
