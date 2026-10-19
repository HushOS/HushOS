#!/usr/bin/env bash
# Builds the Android APK of a release and attaches it to the GitHub release, for phones without
# Google Play. Run it after the Play bundle of the same tag (CONTRIBUTING.md, Releasing):
#
#   apps/android/scripts/release-apk.sh v1.2.3      # or: bun run android:release-apk v1.2.3
#
# It builds in a temporary worktree at the tag, the Rust core included, whatever this checkout
# has checked out, and refuses a tag whose package.json names another version. versionName is
# that version and versionCode is scripts/build-number.sh --store at the tag, the Play bundle's.
# The upload key comes as for bundle-release.sh: storeFile and keyAlias from this checkout's
# apps/android/keystore.properties (or the HUSHOS_UPLOAD_* variables), the password from
# HUSHOS_UPLOAD_STORE_PASSWORD or the keychain item "hushos-android-upload". Nothing secret is
# printed. The APK must carry the upload certificate below, or nothing is uploaded: a phone that
# installed one APK takes updates only from APKs signed with the same key.
#
# It uploads HushOS-X.Y.Z.apk and HushOS-X.Y.Z.apk.sha256 (replacing earlier ones) and writes
# the Android and iOS section of the release's notes (scripts/release-notes-section.sh), so it
# can run again. The files stay in apps/android/build/release-apk.
set -euo pipefail
UPLOAD_CERT_SHA256=1B:FD:E7:01:A4:DE:68:3E:BD:7A:3F:18:2E:C6:6C:04:5D:D9:9D:5D:76:BE:67:AD:8F:44:5E:0B:84:BC:FD:F3
PLAY_URL='https://play.google.com/store/apps/details?id=com.hushos.app'

[[ $# -eq 1 && "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <vX.Y.Z>" >&2; exit 1; }
TAG=$1
VERSION=${TAG#v}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
ANDROID=$ROOT/apps/android
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
BUILD_TOOLS=$(command ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
GH_REPO=${GH_REPO:-$(git -C "$ROOT" remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##')}
export GH_REPO

# The tag as origin has it (a tag that moved stops the fetch), and the main it must be on.
git -C "$ROOT" fetch --quiet origin main "refs/tags/$TAG:refs/tags/$TAG"
declared=$(git -C "$ROOT" show "$TAG:package.json" | jq -r .version)
[[ "$declared" == "$VERSION" ]] || { echo "$TAG's package.json says $declared, not $VERSION: no APK." >&2; exit 1; }
gh release view "$TAG" --json tagName > /dev/null || { echo "No GitHub release for $TAG yet." >&2; exit 1; }

# The upload key, read as app/build.gradle.kts reads it: the properties file first, then the
# environment. The worktree has no keystore.properties, so everything goes in as variables.
prop() {
    [[ -f "$ANDROID/keystore.properties" ]] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*[=:][[:space:]]*//p" "$ANDROID/keystore.properties" | tail -n 1
}
store_file=$(prop storeFile)
store_file=${store_file:-${HUSHOS_UPLOAD_STORE_FILE:-}}
[[ -n "$store_file" ]] || { echo "No upload key: create it with scripts/release-wizard.sh (or see docs/release/signing.md)." >&2; exit 1; }
[[ "$store_file" == /* ]] || store_file=$ANDROID/$store_file
[[ -f "$store_file" ]] || { echo "The upload keystore $store_file does not exist." >&2; exit 1; }
export HUSHOS_UPLOAD_STORE_FILE=$store_file
key_alias=$(prop keyAlias)
export HUSHOS_UPLOAD_KEY_ALIAS=${key_alias:-${HUSHOS_UPLOAD_KEY_ALIAS:-upload}}
store_password=$(prop storePassword)
if [[ -n "$store_password" ]]; then
    export HUSHOS_UPLOAD_STORE_PASSWORD=$store_password
elif [[ -z "${HUSHOS_UPLOAD_STORE_PASSWORD:-}" ]]; then
    HUSHOS_UPLOAD_STORE_PASSWORD=$(security find-generic-password -s hushos-android-upload -a upload -w 2>/dev/null) || {
        echo "The upload key's password is neither in HUSHOS_UPLOAD_STORE_PASSWORD nor in the keychain item hushos-android-upload." >&2
        exit 1
    }
    export HUSHOS_UPLOAD_STORE_PASSWORD
fi
key_password=$(prop keyPassword)
[[ -z "$key_password" ]] || export HUSHOS_UPLOAD_KEY_PASSWORD=$key_password
unset store_password key_password

WORK=$(mktemp -d "${TMPDIR:-/tmp}/hushos-apk.XXXXXX")
SRC=$WORK/src
cleanup() {
    git -C "$ROOT" worktree remove --force "$SRC" 2> /dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT
git -C "$ROOT" worktree add --quiet --detach "$SRC" "$TAG"

# Every copy of the version agrees with package.json, and the version code is the bundle's.
(cd "$SRC" && bun scripts/check-versions.ts)
BUILD=$("$SRC/scripts/build-number.sh" --store)
echo "Building the HushOS $VERSION ($BUILD) APK from $TAG"
"$SRC/apps/android/scripts/build-core.sh"
# No daemons left behind: this is a one-off build in a directory that is about to go.
(cd "$SRC/apps/android" && ./gradlew :app:assembleRelease -q --no-daemon \
    -Pkotlin.compiler.execution.strategy=in-process -PbuildNumber="$BUILD")
BUILT=$SRC/apps/android/app/build/outputs/apk/release/app-release.apk

# Only the upload key, and only this release's version.
certs=$("$BUILD_TOOLS/apksigner" verify --print-certs "$BUILT")
if grep -q "CN=Android Debug" <<< "$certs"; then
    echo "$BUILT is signed with the debug key; the upload key was not picked up." >&2
    exit 1
fi
expected=$(tr -d ':' <<< "$UPLOAD_CERT_SHA256" | tr '[:upper:]' '[:lower:]')
# One line per signer and scheme: "Signer #1 certificate SHA-256 digest: ..." from older
# build-tools, "V2 Signer: certificate SHA-256 digest: ..." from newer ones.
signers=$(sed -En 's/^(Signer #[0-9]+|V[0-9.]+ Signer:) certificate SHA-256 digest: //p' <<< "$certs" | sort -u)
if [[ "$signers" != "$expected" ]]; then
    echo "The APK's signing certificate is not the upload key's (SHA-256 $UPLOAD_CERT_SHA256); found: ${signers:-none}" >&2
    exit 1
fi
# Read it all first: head closing the pipe early would kill aapt2, and pipefail the script.
dump=$("$BUILD_TOOLS/aapt2" dump badging "$BUILT")
badging=${dump%%$'\n'*}
wanted="package: name='com.hushos.app' versionCode='$BUILD' versionName='$VERSION'"
if [[ "$badging" != "$wanted"* ]]; then
    echo "The APK says: $badging" >&2
    echo "Expected:     $wanted" >&2
    exit 1
fi
# The notes say 64-bit phones only: stop if the APK's native code no longer matches that.
abis=$(sed -n "s/^native-code: //p" <<< "$dump")
if [[ "$abis" != "'arm64-v8a' 'x86_64'" ]]; then
    echo "The APK's native code is $abis, not 'arm64-v8a' 'x86_64': update the notes' 64-bit line." >&2
    exit 1
fi

OUT=$ANDROID/build/release-apk
NAME=HushOS-$VERSION.apk
mkdir -p "$OUT"
cp "$BUILT" "$OUT/$NAME"
(cd "$OUT" && shasum -a 256 "$NAME" > "$NAME.sha256")
DIGEST=$(cut -d ' ' -f 1 "$OUT/$NAME.sha256")
echo "$NAME: SHA-256 $DIGEST, signed with the upload key"

gh release upload "$TAG" "$OUT/$NAME" "$OUT/$NAME.sha256" --clobber
DOWNLOAD=https://github.com/$GH_REPO/releases/download/$TAG
cat > "$WORK/section.md" << EOF
## Android

- **Google Play:** [HushOS on Google Play]($PLAY_URL), once approved.
- **APK**, for phones without Google Play: [$NAME]($DOWNLOAD/$NAME), version $VERSION (build $BUILD).
    - SHA-256: \`$DIGEST\` ([$NAME.sha256]($DOWNLOAD/$NAME.sha256))
    - Signing certificate SHA-256: \`$UPLOAD_CERT_SHA256\`
    - Runs on 64-bit phones only (arm64-v8a and x86_64), which is nearly every phone from the last several years.

Check it before installing: \`shasum -a 256 -c $NAME.sha256\`, then \`apksigner verify --print-certs $NAME\` (Android SDK build-tools) must show the certificate SHA-256 digest \`$expected\` and no other: the certificate above, without colons.

Google Play and this APK are signed with different keys (Google's, and HushOS's upload key), so Android won't update one with the other. To switch, uninstall the app first: that removes what it keeps on the phone, such as offline copies, and you sign in again. Your files stay in HushOS.

## iOS

App Store link to come. There is no IPA: Apple doesn't let people install iPhone apps from a download like this.
EOF
"$ROOT/scripts/release-notes-section.sh" "$TAG" apps "$WORK/section.md"
