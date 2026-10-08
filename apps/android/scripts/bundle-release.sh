#!/usr/bin/env bash
# Builds the release App Bundle (.aab) for Google Play, signed with the upload key.
#
#   apps/android/scripts/bundle-release.sh            # build with the versions in app/build.gradle.kts
#   apps/android/scripts/bundle-release.sh 0.1.0 2    # set versionName and versionCode first
#
# The upload key comes from apps/android/keystore.properties (storeFile, keyAlias) and its
# password from HUSHOS_UPLOAD_STORE_PASSWORD or, failing that, the macOS login keychain item
# "hushos-android-upload" that scripts/release-wizard.sh saves. Nothing secret is printed.
# Every upload needs a versionCode higher than any Play has seen; commit the change after.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

if [[ $# -ge 2 ]]; then
    [[ "$1" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "The version must look like 1.0 or 1.0.0" >&2; exit 1; }
    [[ "$2" =~ ^[0-9]+$ ]] || { echo "The version code must be a whole number" >&2; exit 1; }
    sed -i '' -E "s/(versionCode = )[0-9]+/\1$2/; s/(versionName = )\"[^\"]*\"/\1\"$1\"/" app/build.gradle.kts
fi
grep -E "versionCode = |versionName = " app/build.gradle.kts | sed 's/^ */build.gradle.kts: /'

if [[ ! -f keystore.properties && -z "${HUSHOS_UPLOAD_STORE_FILE:-}" ]]; then
    echo "No upload key: create it with scripts/release-wizard.sh (or see docs/release/signing.md)." >&2
    exit 1
fi
if [[ -z "${HUSHOS_UPLOAD_STORE_PASSWORD:-}" ]]; then
    HUSHOS_UPLOAD_STORE_PASSWORD=$(security find-generic-password -s hushos-android-upload -a upload -w 2>/dev/null) || {
        echo "The upload key's password is neither in HUSHOS_UPLOAD_STORE_PASSWORD nor in the keychain item hushos-android-upload." >&2
        exit 1
    }
    export HUSHOS_UPLOAD_STORE_PASSWORD
fi

[[ -d core/src/main/jniLibs ]] || (cd ../.. && bun run core:android)
./gradlew :app:bundleRelease -q
AAB=app/build/outputs/bundle/release/app-release.aab
# Refuse to hand over a bundle signed with the debug key (Play would refuse it too, later).
if "$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" | grep -q "CN=Android Debug"; then
    echo "$AAB is signed with the debug key; the upload key was not picked up." >&2
    exit 1
fi
echo "Signed with: $("$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" | grep -m1 'SHA256:' | sed 's/^[[:space:]]*//')"
ls -la "$AAB"
