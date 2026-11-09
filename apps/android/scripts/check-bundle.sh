#!/usr/bin/env bash
# Checks a release App Bundle before it goes to Google Play, for what Play Console's upload
# screens would have shown and the API does not: who signed it, which version it is, and which
# phones it reaches.
#
#   apps/android/scripts/check-bundle.sh <app-release.aab> <X.Y.Z> <versionCode> [<previous release's APK>]
#
# - Signed with the upload key (the certificate below, as in release-apk.sh) and nothing else.
# - Built with the Firebase options phone notifications need (the manifest's com.hushos.push.configured).
# - Package com.hushos.app, the given versionName and versionCode.
# - Device compatibility: minSdk, native ABIs, required and implied hardware features, screen
#   and library requirements, read from the bundle's base module with aapt2 the way Play reads
#   them. Uploading in Play Console shows a review when the number of supported devices changes;
#   uploading through the API skips it. So, with the previous release's APK (attached to its
#   GitHub release, built from the same manifest), any difference stops here; without one, the
#   ABIs must be the two the release notes promise. HUSHOS_ACCEPT_DEVICE_CHANGE=1 lets an
#   intended change through, and the difference is still printed.
#
# Needs JAVA_HOME (keytool), ANDROID_HOME (the newest build-tools' aapt2), unzip and zip.
set -euo pipefail
UPLOAD_CERT_SHA256=1B:FD:E7:01:A4:DE:68:3E:BD:7A:3F:18:2E:C6:6C:04:5D:D9:9D:5D:76:BE:67:AD:8F:44:5E:0B:84:BC:FD:F3
PACKAGE=com.hushos.app
EXPECTED_ABIS="'arm64-v8a' 'x86_64'"

[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: $0 <app-release.aab> <X.Y.Z> <versionCode> [<previous release's APK>]" >&2; exit 1; }
AAB=$1 VERSION=$2 CODE=$3 PREVIOUS=${4:-}
[[ -s "$AAB" ]] || { echo "$AAB does not exist or is empty" >&2; exit 1; }
[[ -z "$PREVIOUS" || -s "$PREVIOUS" ]] || { echo "$PREVIOUS does not exist or is empty" >&2; exit 1; }
: "${JAVA_HOME:?JAVA_HOME is not set}" "${ANDROID_HOME:?ANDROID_HOME is not set}"
BUILD_TOOLS=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)
AAPT2=$BUILD_TOOLS/aapt2
[[ -x "$AAPT2" ]] || { echo "No aapt2 in $BUILD_TOOLS" >&2; exit 1; }

# The signature: every certificate of every signer, and none but the upload key's.
signers=$("$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" | sed -n 's/^[[:space:]]*SHA256: //p' | sort -u)
if [[ "$signers" != "$UPLOAD_CERT_SHA256" ]]; then
    echo "$AAB is not signed with the upload key alone (SHA-256 $UPLOAD_CERT_SHA256); found: ${signers:-no signature}" >&2
    exit 1
fi
echo "Signed with the upload key only: $UPLOAD_CERT_SHA256"

# The base module as an APK aapt2 can read: a bundle keeps the manifest and resources as
# protobuf under base/, which `aapt2 convert` turns into an ordinary binary APK.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hushos-bundle.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
unzip -q "$AAB" 'base/*' -d "$WORK"
mv "$WORK/base/manifest/AndroidManifest.xml" "$WORK/base/AndroidManifest.xml"
rmdir "$WORK/base/manifest"
(cd "$WORK/base" && zip -qr ../proto.apk AndroidManifest.xml resources.pb res lib)
"$AAPT2" convert --output-format binary -o "$WORK/binary.apk" "$WORK/proto.apk"
# Read it all first: head closing the pipe early would kill aapt2, and pipefail the script.
dump=$("$AAPT2" dump badging "$WORK/binary.apk")
badging=${dump%%$'\n'*}
wanted="package: name='$PACKAGE' versionCode='$CODE' versionName='$VERSION'"
if [[ "$badging" != "$wanted"* ]]; then
    echo "The bundle says: $badging" >&2
    echo "Expected:        $wanted" >&2
    exit 1
fi
echo "$wanted"

# Phone notifications: the build carried all four Firebase options (app/build.gradle.kts fails a release without them;
# this catches a bundle built some other way).
manifest=$("$AAPT2" dump xmltree --file AndroidManifest.xml "$WORK/binary.apk")
# aapt2 prints the value typed (=true) or as text (="true"), depending on how the placeholder was read.
if ! grep -A1 'com.hushos.push.configured' <<< "$manifest" | grep -Eq ':value\([^)]*\)=("true"|true)( |$)'; then
    echo "The bundle was built without the Firebase options, so it has no phone notifications (hushos.firebase.* in docs/push-relay-plan.md)" >&2
    exit 1
fi
echo "Phone notifications: Firebase options present"

# What Play filters devices on; features sit indented under feature-group. uses-*-not-required
# lines filter nothing and are left out.
compatibility() {
    sed -E 's/^[[:space:]]+//' \
        | grep -E "^(minSdkVersion|sdkVersion|maxSdkVersion|native-code|uses-feature|uses-implied-feature|uses-library|uses-native-library|uses-gl-es|uses-configuration|supports-gl-texture|supports-screens|supports-any-density|requires-smallest-width|compatible-width-limit|largest-width-limit):" \
        | sort || true
}
current=$(compatibility <<< "$dump")
echo "Device compatibility:"
while IFS= read -r line; do echo "    $line"; done <<< "$current"

if [[ -n "$PREVIOUS" ]]; then
    previous_dump=$("$AAPT2" dump badging "$PREVIOUS")
    previous=$(compatibility <<< "$previous_dump")
    if [[ "$current" == "$previous" ]]; then
        echo "The same phones as the previous release ($(basename "$PREVIOUS"))."
        exit 0
    fi
    echo "The phones this release reaches differ from the previous release's ($(basename "$PREVIOUS")):" >&2
    { diff <(echo "$previous") <(echo "$current") || true; } | sed -n 's/^</    was:/p; s/^>/    now:/p' >&2
else
    abis=$(sed -n "s/^native-code: //p" <<< "$current")
    if [[ "$abis" == "$EXPECTED_ABIS" ]]; then
        echo "No previous release's APK to compare with; native code is $abis, as the release notes say."
        exit 0
    fi
    echo "The bundle's native code is ${abis:-none}, not $EXPECTED_ABIS (the release notes' 64-bit line)." >&2
fi
if [[ "${HUSHOS_ACCEPT_DEVICE_CHANGE:-}" == 1 ]]; then
    echo "HUSHOS_ACCEPT_DEVICE_CHANGE=1: going ahead with the change above."
    exit 0
fi
echo "Play Console would ask you to review this change in supported devices; the API does not. If it is intended, run again with HUSHOS_ACCEPT_DEVICE_CHANGE=1 (the workflow's accept-device-change input)." >&2
exit 1
