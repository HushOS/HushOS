#!/usr/bin/env bash
# Store screenshots for the App Store (6.9" iPhone, 1320x2868) and Google Play (1080x1920),
# taken from the debug apps signed in to the local demo account, in light mode with a clean
# status bar. Guided: the script opens each place it can by deep link and asks you to do the
# rest by hand (one or two taps), then press Enter; it captures and checks the size.
#
#   bun dev                                   # the web dev server on :5173, with the demo account
#   scripts/store-screenshots.sh ios          # or: android, or both (the default)
#
# It uses its own simulator ("HushOS AppStore 6.9") and its own emulator ("HushOS_Store",
# 1080x1920), never the ones you develop on. AVD names another emulator instead (say the site's
# HushOS_Site): its screen is set to 1080x1920 at Pixel 2 density for the shots and put back
# after. The emulator refuses to start while another one is running, because a second device
# breaks plain `adb` commands elsewhere.
# Output: docs/release/screenshots/{ios,android}/NN-name.png. The shot list and captions are
# in docs/release/store-listing.md.
#
# Demo account (made by e2e/screenshots.spec.ts with Jonas Berg, Holidays shared with him and one
# link, and the two of them in Lindqvist family; the names are made up and the photos are CC0):
#   DEMO_EMAIL     default the newest maya.lindqvist@ account in the local database
#   LISBON_FOLDER  the "Holidays/Lisbon 2026" folder id (found in the local database if unset)
#   PHOTO          a photo in it (likewise)
# The password is e2e/helpers.ts's PASSWORD; the script puts it on the clipboard, never prints it.
#   PORT           the web server the apps talk to (default 5173). Another port (an isolated
#                  instance, say) rebuilds the Android debug app to talk to it.
#   DB             its database (default hushos), in the hushos-db-1 container.
#   SIGNED_IN      set when the app (both platforms) is already signed in as the demo account.
#   SIM            another 6.9-inch iPhone simulator's name, if "HushOS AppStore 6.9" can't be used.
# Times on screen are in a timezone where it is mid-morning now (e2e/morning-zone.ts), as on the web.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
WHICH="${1:-both}"
PORT="${PORT:-5173}"
DB="${DB:-hushos}"
DEMO_EMAIL="${DEMO_EMAIL:-$(docker exec hushos-db-1 psql -U hushos -d "$DB" -Atc "select email from users where email like 'maya.lindqvist@%' order by created_at desc limit 1" 2>/dev/null || true)}"
[[ -n "$DEMO_EMAIL" ]] || { echo "No demo account: run SCREENSHOTS=1 bunx playwright test e2e/screenshots.spec.ts --project=chromium first." >&2; exit 1; }
ZONE=$(bun e2e/morning-zone.ts "$(docker exec hushos-db-1 psql -U hushos -d "$DB" -Atc "select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from users where email = '$DEMO_EMAIL'")")
OUT="$ROOT/docs/release/screenshots"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
wait_enter() { printf '  %s\n  Press Enter to capture. ' "$1"; read -r _; }

curl -s -o /dev/null --max-time 5 "http://localhost:$PORT/" || fail "Start the web dev server first (bun dev): the debug apps talk to http://localhost:$PORT."

# The demo folder and a photo in it, by structure (names are encrypted, so the server can't
# tell): the account's one folder that holds exactly twelve files and nothing else.
if [[ -z "${LISBON_FOLDER:-}" || -z "${PHOTO:-}" ]]; then
    query="select f.id, (select c.id from drive_nodes c where c.parent_id = f.id and c.trashed_at is null order by c.created_at limit 1)
        from drive_nodes f join users u on u.id = f.created_by
        where u.email = '$DEMO_EMAIL' and f.kind = 'folder' and f.trashed_at is null
        and (select count(*) from drive_nodes c where c.parent_id = f.id and c.trashed_at is null and c.kind = 'file') = 12
        and (select count(*) from drive_nodes c where c.parent_id = f.id and c.trashed_at is null) = 12 limit 1"
    found=$(docker exec hushos-db-1 psql -U hushos -d "$DB" -Atc "$query" 2>/dev/null || true)
    LISBON_FOLDER="${LISBON_FOLDER:-${found%%|*}}"
    PHOTO="${PHOTO:-${found##*|}}"
fi
[[ -n "${LISBON_FOLDER:-}" && -n "${PHOTO:-}" ]] || fail "Couldn't find the demo's Lisbon 2026 folder. Set LISBON_FOLDER and PHOTO (open them on the web; the ids are in the address bar)."

password_to_clipboard() {
    sed -n "s/^export const PASSWORD = '\(.*\)';$/\1/p" e2e/helpers.ts | tr -d '\n' | pbcopy
}

check_size() { # file width height
    local w h
    w=$(sips -g pixelWidth "$1" | awk '/pixelWidth/ {print $2}')
    h=$(sips -g pixelHeight "$1" | awk '/pixelHeight/ {print $2}')
    [[ "$w" == "$2" && "$h" == "$3" ]] || fail "$1 is ${w}x${h}, expected ${2}x${3}."
    # Both stores refuse transparency: if a capture has an alpha channel, drop it.
    if sips -g hasAlpha "$1" | grep -q "hasAlpha: yes"; then
        sips -s format jpeg -s formatOptions 100 "$1" --out "$1.jpg" >/dev/null
        sips -s format png "$1.jpg" --out "$1" >/dev/null
        rm -f "$1.jpg"
    fi
    printf '  saved %s (%sx%s)\n' "${1#"$ROOT"/}" "$w" "$h"
}

ios() {
    local name="${SIM:-HushOS AppStore 6.9}" udid app runtime
    udid=$(xcrun simctl list devices available | grep "$name (" | grep -oE '[0-9A-F-]{36}' | head -1 || true)
    if [[ -z "$udid" ]]; then
        # The newest runtime that has a 6.9-inch iPhone (a newer runtime may not have the model).
        for runtime in $(xcrun simctl list runtimes available | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+' | sort -rV); do
            for type in iPhone-18-Pro-Max iPhone-17-Pro-Max; do
                udid=$(xcrun simctl create "$name" "com.apple.CoreSimulator.SimDeviceType.$type" "$runtime" 2>/dev/null) && break 2
            done
        done || true
    fi
    [[ -n "$udid" ]] || fail "Couldn't create a 6.9-inch iPhone simulator."
    app="apps/ios/DerivedData/Build/Products/Debug-iphonesimulator/HushOS.app"
    [[ -d "$app" ]] || bun run ios:build
    xcrun simctl boot "$udid" 2>/dev/null || true
    xcrun simctl bootstatus "$udid" -b >/dev/null
    # Simulator.app, if this Xcode has one; the shots don't need its window.
    open -a Simulator --args -CurrentDeviceUDID "$udid" 2>/dev/null || true
    xcrun simctl ui "$udid" appearance light
    # The time on the device (in the morning zone), set again before every capture, so the clock
    # is never earlier than the newest row on screen.
    clock() {
        xcrun simctl status_bar "$udid" override --time "$(TZ=$ZONE date '+%-I:%M')" --dataNetwork wifi \
            --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --operatorName "" \
            --batteryState charged --batteryLevel 100
    }
    clock
    xcrun simctl install "$udid" "$app"
    # The app's clock in the morning zone, with any 24-hour override off, so rows read
    # "Today, 10:24 AM", as on Android. A link opens through a debug-only launch argument,
    # since `simctl openurl` makes iOS ask "Open in HushOS?" first.
    launch() { # [link] [extra arguments]
        xcrun simctl terminate "$udid" com.hushos.app 2>/dev/null || true
        if [[ -n "${1:-}" ]]; then
            SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.hushos.app -AppleICUForce24HourTime NO -HushOSOpenLink "$1" "${@:2}" >/dev/null
        else
            SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.hushos.app -AppleICUForce24HourTime NO >/dev/null
        fi
    }
    launch
    mkdir -p "$OUT/ios"
    shot() { # number name instruction [link] [extra launch arguments]
        [[ -n "${4:-}" ]] && launch "$4" "${@:5}"
        wait_enter "$3"
        clock
        sleep 1
        xcrun simctl io "$udid" screenshot --type=png "$OUT/ios/$1-$2.png" >/dev/null 2>&1
        check_size "$OUT/ios/$1-$2.png" 1320 2868
    }
    say "iOS, on \"$name\"."
    # SIGNED_IN=1 when the simulator's app is already signed in as the demo account.
    if [[ -z "${SIGNED_IN:-}" ]]; then
        password_to_clipboard
        xcrun simctl pbcopy "$udid" < <(sed -n "s/^export const PASSWORD = '\(.*\)';$/\1/p" e2e/helpers.ts | tr -d '\n')
        local server=""
        [[ "$PORT" != 5173 ]] && server=" First set the server: the gear > Self-hosting > Server address http://localhost:$PORT > Save."
        wait_enter "Sign in as $DEMO_EMAIL; the password is on the simulator's clipboard (paste it).$server Allow or dismiss any prompt, then come back here."
        printf '' | xcrun simctl pbcopy "$udid"
    fi
    say "First keep Lisbon 2026, Finances and Q3 report.md on this phone (each one's menu > Keep on this phone), so Home and shot 5 have something to show."
    # In the App Store's order (store-listing.md); the names match Android's captures.
    shot 01 home "Home, scrolled to the top, no prompt or notice on screen." "hushos://app"
    shot 02 folder "Lisbon 2026 as a grid of photos." "hushos://app/drive?folder=$LISBON_FOLDER" -files.view grid
    shot 09 colours "Files, at the top, as a list: Holidays, Finances and Recipes in their colours." "hushos://app/drive" -files.view list
    # The family's folders and members, nothing about the plan above them (store-listing.md).
    shot 10 family "Account > Lindqvist family: its folders (Family, Household) and members, scrolled to the top." ""
    shot 03 share "Files > Holidays, tap Manage on the banner, so the sheet is titled Holidays and shows Maya, Jonas and one link." ""
    shot 07 words "Shared > Contacts > Your twelve words, so no plan shows behind the sheet." ""
    shot 05 phone "Home > On this phone." "hushos://app"
    # The Files app on its own, so the status bar has no "Back to HushOS" link, on the same clock.
    xcrun simctl terminate "$udid" com.hushos.app 2>/dev/null || true
    xcrun simctl terminate "$udid" com.apple.DocumentsApp 2>/dev/null || true
    SIMCTL_CHILD_TZ="$ZONE" xcrun simctl launch "$udid" com.apple.DocumentsApp -AppleICUForce24HourTime NO >/dev/null
    shot 08 files "In Files: Browse > HushOS > Holidays > Lisbon 2026, as icons (if HushOS isn't listed, the ... menu > Edit turns it on)." ""
    xcrun simctl status_bar "$udid" clear
    say "iOS done: $OUT/ios"
}

android() {
    local avd="${AVD:-HushOS_Store}" serial apk="apps/android/app/build/outputs/apk/debug/app-debug.apk"
    if adb devices | grep -q "device$"; then
        fail "Another Android device or emulator is connected (adb devices). Close it first, so this script's emulator doesn't disturb it."
    fi
    if ! emulator -list-avds | grep -qx "$avd"; then
        echo "no" | avdmanager create avd -n "$avd" -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_2 >/dev/null
    fi
    if [[ "$PORT" != 5173 ]]; then
        (cd apps/android && ./gradlew :app:assembleDebug -q -PdefaultOrigin="http://localhost:$PORT")
    else
        [[ -f "$apk" ]] || bun run android:build
    fi
    nohup emulator -avd "$avd" -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
    adb wait-for-device
    until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done
    serial=$(adb get-serialno)
    local a="adb -s $serial"
    # Play's 1080x1920 on an emulator with another screen: Pixel 2's size and density, put back below.
    local physical
    physical=$($a shell wm size | sed -n 's/^Physical size: //p' | tr -d '\r')
    if [[ "$physical" != 1080x1920 ]]; then
        # Put the screen back however the run ends (a failed capture, Ctrl-C), or the next
        # site-phone-shots.sh run on this emulator captures the overridden layout.
        trap "$a shell wm size reset >/dev/null 2>&1 || true; $a shell wm density reset >/dev/null 2>&1 || true" EXIT
        $a shell wm size 1080x1920
        $a shell wm density 420
    fi
    $a install -r "$apk" >/dev/null
    $a reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
    $a reverse tcp:9000 tcp:9000 >/dev/null
    $a shell cmd uimode night no >/dev/null
    $a shell cmd alarm set-timezone "$ZONE" >/dev/null
    $a shell settings put global sysui_demo_allowed 1
    demo() { $a shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
    demo enter
    # The time on the device, so the clock is never earlier than the newest row on screen.
    demo clock -e hhmm "$(TZ=$ZONE date +%H%M)"
    demo network -e wifi show -e level 4 -e fully true
    # Wi-Fi only: a mobile signal drew a "3G" badge that datatype none did not remove.
    demo network -e mobile hide
    demo battery -e level 100 -e plugged false
    demo notifications -e visible false
    $a shell am start -n com.hushos.app/.MainActivity >/dev/null
    mkdir -p "$OUT/android"
    shot() { # number name instruction [deep link]
        [[ -n "${4:-}" ]] && $a shell am start -W -a android.intent.action.VIEW -d "'$4'" com.hushos.app >/dev/null
        wait_enter "$3"
        $a exec-out screencap -p > "$OUT/android/$1-$2.png"
        check_size "$OUT/android/$1-$2.png" 1080 1920
    }
    # SIGNED_IN=1 when the emulator's app is already signed in as the demo account.
    if [[ -z "${SIGNED_IN:-}" ]]; then
        say "Android, on the $avd emulator. Sign in first."
        printf '  Tap the Email field on the emulator, then press Enter here. '
        read -r _
        $a shell input text "$DEMO_EMAIL"
        printf '  Tap the Password field, then press Enter here (the script types it). '
        read -r _
        $a shell input text "$(sed -n "s/^export const PASSWORD = '\(.*\)';$/\1/p" e2e/helpers.ts)"
        wait_enter "Tap Sign in. Allow notifications if asked, and wait for Home."
    fi
    say "First keep Lisbon 2026, Finances and Q3 report.md on this phone (each one's ⋮ > Keep on this phone)."
    shot 01 home "Home, scrolled to the top." "hushos://app"
    shot 02 folder "Lisbon 2026 as a grid: More (or the sort button on Android) > View > Grid." "hushos://app/drive?folder=$LISBON_FOLDER"
    shot 03 share "Back up to Holidays, tap Manage on the banner, so the sheet is titled Holidays and shows Maya, Jonas and one link." ""
    shot 05 phone "Home > On this phone." "hushos://app"
    shot 07 words "Shared > Contacts > Your twelve words, so no plan shows behind the sheet." ""
    shot 08 files "Android's Files app: the menu > HushOS > Holidays > Lisbon 2026, as a grid." ""
    shot 09 colours "Files, at the top, as a list: Holidays, Finances and Recipes in their colours." "hushos://app/drive"
    # The family's folders, nothing about the plan behind them (store-listing.md).
    shot 10 family "Account > Lindqvist family: its folders (Family, Household) and members, scrolled to the top." ""
    demo exit
    if [[ "$physical" != 1080x1920 ]]; then
        $a shell wm size reset
        $a shell wm density reset
        trap - EXIT
    fi
    $a emu kill >/dev/null 2>&1 || true
    say "Android done: $OUT/android"
}

case "$WHICH" in
    ios) ios ;;
    android) android ;;
    both) ios; android ;;
    *) fail "Usage: scripts/store-screenshots.sh [ios|android|both]" ;;
esac
pbcopy < /dev/null
