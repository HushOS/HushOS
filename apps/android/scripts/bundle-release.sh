#!/usr/bin/env bash
# Builds the release App Bundle (.aab) for Google Play, signed with the upload key.
#
#   apps/android/scripts/bundle-release.sh
#
# versionName is the product version in app/build.gradle.kts, which the release pull request
# keeps equal to the root package.json (bun run check:versions holds them together); versionCode
# is scripts/build-number.sh, the commit count on main, passed as -PbuildNumber. Nothing is
# edited or committed. Build from main, best at a release tag (git checkout v1.2.3).
# The upload key comes from apps/android/keystore.properties (storeFile, keyAlias) and its
# password from HUSHOS_UPLOAD_STORE_PASSWORD or, failing that, the macOS login keychain item
# "hushos-android-upload" that scripts/release-wizard.sh saves. Nothing secret is printed.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

[[ $# -eq 0 ]] || { echo "bundle-release.sh takes no arguments: the version is package.json's, the version code scripts/build-number.sh's" >&2; exit 1; }
# Every copy of the version agrees with package.json, or nothing is built.
(cd ../.. && bun scripts/check-versions.ts)
VERSION=$(cd ../.. && bun -p 'require("./package.json").version')
BUILD=$(../../scripts/build-number.sh --store)
echo "Building HushOS $VERSION ($BUILD)"

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
./gradlew :app:bundleRelease -q -PbuildNumber="$BUILD"
AAB=app/build/outputs/bundle/release/app-release.aab
# Refuse to hand over a bundle signed with the debug key (Play would refuse it too, later).
if "$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" | grep -q "CN=Android Debug"; then
    echo "$AAB is signed with the debug key; the upload key was not picked up." >&2
    exit 1
fi
echo "Signed with: $("$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" | grep -m1 'SHA256:' | sed 's/^[[:space:]]*//')"
ls -la "$AAB"
