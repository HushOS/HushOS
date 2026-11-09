#!/usr/bin/env bash
# Builds the unsigned iOS IPA of a release and attaches it to the GitHub release, for people who
# sideload with AltStore, SideStore or iloader. Run it after the release exists (CONTRIBUTING.md,
# Releasing), from any up-to-date checkout of main:
#
#   apps/ios/scripts/release-ipa.sh v1.2.3      # or: bun run ios:release-ipa v1.2.3
#   UPLOAD=0 apps/ios/scripts/release-ipa.sh v1.2.3   # build and check it, upload nothing
#   apps/ios/scripts/release-ipa.sh --here      # this checkout as it is, nothing uploaded
#
# It builds in a temporary worktree at the tag, the Rust core included, whatever this checkout has
# checked out, and refuses a tag whose package.json names another version. The build is Release for
# generic iOS (arm64) with CODE_SIGNING_ALLOWED=NO and the default APP_GROUP_ID; the version is the
# tag's, the build number scripts/build-number.sh --store at the tag, as the App Store build's.
#
# No team signs it. Each bundle is then signed ad hoc ("-", no identity, nothing a phone accepts)
# only to carry its entitlements: a sideloading tool reads them from the binary to know what to ask
# its Apple account for (the app group the app and its extensions share), and signs every bundle
# again under the person's team. The tool renames the group for that team; HushOSKit's AppGroup
# finds the new name in the profile the tool embeds.
#
# It uploads HushOS-X.Y.Z-unsigned.ipa and HushOS-X.Y.Z-unsigned.ipa.sha256 (replacing earlier
# ones) and writes the iOS section of the release's notes (scripts/release-notes-section.sh), so it
# can run again. The files stay in apps/ios/build/release-ipa.
set -euo pipefail
GROUP=group.com.hushos.app
LINK_HOST=hushos.com

usage() { echo "usage: $0 <vX.Y.Z> | --here" >&2; exit 1; }
[[ $# -eq 1 ]] || usage
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=$ROOT/apps/ios/build/release-ipa
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hushos-ipa.XXXXXX")
SRC=$WORK/src
cleanup() {
    [[ "${HERE:-0}" == 1 ]] || git -C "$ROOT" worktree remove --force "$SRC" 2> /dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

if [[ "$1" == --here ]]; then
    HERE=1 UPLOAD=0
    SRC=$ROOT
    VERSION=$(jq -r .version "$ROOT/package.json")
    BUILD=$("$ROOT/scripts/build-number.sh")
else
    [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
    TAG=$1
    VERSION=${TAG#v}
    GH_REPO=${GH_REPO:-$(git -C "$ROOT" remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##')}
    export GH_REPO
    # The tag as origin has it (a tag that moved stops the fetch), and the main it must be on.
    git -C "$ROOT" fetch --quiet origin main "refs/tags/$TAG:refs/tags/$TAG"
    declared=$(git -C "$ROOT" show "$TAG:package.json" | jq -r .version)
    [[ "$declared" == "$VERSION" ]] || { echo "$TAG's package.json says $declared, not $VERSION: no IPA." >&2; exit 1; }
    [[ "${UPLOAD:-1}" == 0 ]] || gh release view "$TAG" --json tagName > /dev/null || { echo "No GitHub release for $TAG yet." >&2; exit 1; }
    git -C "$ROOT" worktree add --quiet --detach "$SRC" "$TAG"
    # Every copy of the version agrees with package.json, and the build number is the App Store build's.
    (cd "$SRC" && bun scripts/check-versions.ts)
    BUILD=$("$SRC/scripts/build-number.sh" --store)
fi
NAME=HushOS-$VERSION-unsigned.ipa
echo "Building the unsigned HushOS $VERSION ($BUILD) IPA from ${TAG:-this checkout}"

IOS=$SRC/apps/ios
[[ "${HERE:-0}" == 1 && -d "$IOS/Packages/HushOSCore/HushOSCoreFFI.xcframework" ]] || "$IOS/scripts/build-core.sh"
(cd "$IOS" && xcodegen generate --quiet)
DERIVED=$WORK/derived
# Release for devices, nothing signed; APP_GROUP_ID and the link host are the defaults whatever a
# Local.xcconfig in this checkout says (the worktree at a tag has none).
xcodebuild -project "$IOS/HushOS.xcodeproj" -scheme HushOS -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -skipPackagePluginValidation -quiet \
    ARCHS=arm64 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    APP_GROUP_ID="$GROUP" HUSHOS_LINK_HOST="$LINK_HOST" CURRENT_PROJECT_VERSION="$BUILD" build
BUILT=$DERIVED/Build/Products/Release-iphoneos/HushOS.app

PAYLOAD=$WORK/ipa/Payload
mkdir -p "$PAYLOAD"
cp -R "$BUILT" "$PAYLOAD/"
APP=$PAYLOAD/HushOS.app

# What each bundle says: this version and build, the default group, nothing signed by a team.
check() {
    local bundle=$1 plist=$1/Info.plist
    [[ "$(plutil -extract CFBundleShortVersionString raw "$plist")" == "$VERSION" ]] || { echo "$bundle is not version $VERSION" >&2; exit 1; }
    [[ "$(plutil -extract CFBundleVersion raw "$plist")" == "$BUILD" ]] || { echo "$bundle is not build $BUILD" >&2; exit 1; }
    [[ "$(plutil -extract HushOSAppGroup raw "$plist")" == "$GROUP" ]] || { echo "$bundle names another app group than $GROUP" >&2; exit 1; }
    [[ ! -e "$bundle/embedded.mobileprovision" ]] || { echo "$bundle carries a provisioning profile" >&2; exit 1; }
}
EXTENSIONS=("$APP"/PlugIns/*.appex)
[[ ${#EXTENSIONS[@]} -eq 5 ]] || { echo "Expected the five extensions in PlugIns, found ${#EXTENSIONS[@]}" >&2; exit 1; }
for bundle in "$APP" "${EXTENSIONS[@]}"; do check "$bundle"; done

# The entitlements a sideloading tool asks for, from each target's file with the build's values.
# keychain-access-groups needs the team's prefix, which only the tool knows; HushOS keeps its
# keychain items under the app group, so nothing is lost by leaving it to the tool.
entitlements() {
    local out
    out=$WORK/$(basename "$1")
    sed -e "s/\$(APP_GROUP_ID)/$GROUP/g" -e "s/\$(HUSHOS_LINK_HOST)/$LINK_HOST/g" "$IOS/$1" > "$out"
    plutil -remove keychain-access-groups "$out" 2> /dev/null || true
    # Pushes reach only the App Store's bundle id (the relay's APNs topic), so a sideloaded build asks for none.
    plutil -remove aps-environment "$out" 2> /dev/null || true
    # shellcheck disable=SC2016 # a literal $( left over is an unfilled build setting
    ! grep -q '$(' "$out" || { echo "$1 has a build setting this script doesn't fill in" >&2; exit 1; }
}
entitlements App/HushOS.entitlements
entitlements Files/HushOSFiles.entitlements
entitlements FilesUI/HushOSFilesUI.entitlements
entitlements Share/HushOSShare.entitlements
entitlements Notifications/HushOSNotifications.entitlements
sign() { codesign --force --sign - --timestamp=none --generate-entitlement-der ${2:+--entitlements "$2"} "$1" 2> /dev/null; }
for framework in "$APP"/Frameworks/*; do if [[ -e "$framework" ]]; then sign "$framework"; fi; done
sign "$APP/PlugIns/HushOSFiles.appex" "$WORK/HushOSFiles.entitlements"
sign "$APP/PlugIns/HushOSFilesUI.appex" "$WORK/HushOSFilesUI.entitlements"
sign "$APP/PlugIns/HushOSShare.appex" "$WORK/HushOSShare.entitlements"
sign "$APP/PlugIns/HushOSNotifications.appex" "$WORK/HushOSNotifications.entitlements"
sign "$APP/PlugIns/HushOSWidgets.appex"
sign "$APP" "$WORK/HushOS.entitlements"
for bundle in "$APP" "$APP/PlugIns/HushOSFiles.appex" "$APP/PlugIns/HushOSFilesUI.appex" "$APP/PlugIns/HushOSShare.appex" \
    "$APP/PlugIns/HushOSNotifications.appex"; do
    codesign -d --entitlements - --xml "$bundle" 2> /dev/null | grep -q "<string>$GROUP</string>" || { echo "$bundle does not carry the app group" >&2; exit 1; }
done
if codesign -d --entitlements - --xml "$APP" 2> /dev/null | grep -q fileprovider.testing-mode; then
    echo "The IPA carries the simulator's File Provider testing mode" >&2
    exit 1
fi

mkdir -p "$OUT"
rm -f "$OUT/$NAME" "$OUT/$NAME.sha256"
# -X: no extended attributes, so no __MACOSX entries; -y keeps any symlink as a link.
(cd "$WORK/ipa" && zip -qryX "$OUT/$NAME" Payload)
! unzip -Z1 "$OUT/$NAME" | grep -qE '^__MACOSX/|/\._' || { echo "$NAME has macOS metadata entries" >&2; exit 1; }
(cd "$OUT" && shasum -a 256 "$NAME" > "$NAME.sha256")
DIGEST=$(cut -d ' ' -f 1 "$OUT/$NAME.sha256")
echo "$NAME: SHA-256 $DIGEST, in $OUT"
[[ "${UPLOAD:-1}" == 1 ]] || exit 0

gh release upload "$TAG" "$OUT/$NAME" "$OUT/$NAME.sha256" --clobber
DOWNLOAD=https://github.com/$GH_REPO/releases/download/$TAG
cat > "$WORK/section.md" << EOF
## iOS

App Store link to come.

- **Unsigned IPA**, for sideloading tools only (AltStore, SideStore, iloader): [$NAME]($DOWNLOAD/$NAME), version $VERSION (build $BUILD). It can't be installed as it is: the tool signs it with your Apple account.
    - SHA-256: \`$DIGEST\` ([$NAME.sha256]($DOWNLOAD/$NAME.sha256))

Check it before sideloading: \`shasum -a 256 -c $NAME.sha256\`.

With a free Apple account the app stops opening after 7 days until the tool refreshes it, and you can sideload only a few apps at a time. Links that open in the app and filling saved passwords need the App Store build.
EOF
"$ROOT/scripts/release-notes-section.sh" "$TAG" ios "$WORK/section.md"
