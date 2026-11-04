#!/usr/bin/env bash
# Sends a release App Bundle to Google Play, or promotes one, through the Play Developer API
# (androidpublisher v3 edits), with nothing but curl and jq. .github/workflows/
# android-release.yml runs it; it runs the same way on a laptop.
#
#   play-publish.sh upload  <app-release.aab> <X.Y.Z> <versionCode>   # internal track, rolled out
#   play-publish.sh dry-run <app-release.aab> <X.Y.Z> <versionCode>   # uploaded and validated, then thrown away
#   play-publish.sh promote <X.Y.Z> <versionCode>                     # internal's release to production, 100%
#
# --print-plan before the command prints the requests it would make, against made-up answers,
# and needs no token and no network.
#
# The access token comes in PLAY_ACCESS_TOKEN, for a service account with release rights on
# the app in Play Console: in the workflow from google-github-actions/auth through Workload
# Identity Federation (no key exists), by hand from
#   gcloud auth print-access-token --impersonate-service-account=<account> \
#       --scopes=https://www.googleapis.com/auth/androidpublisher
# It is never printed. Google's error message is, on any failed request, and an edit that was
# not committed is deleted.
#
# Edits are Play's transactions: one is opened, changed, then committed (or validated and
# deleted), so a failure half-way leaves Play as it was. A bundle's versionCode is spent only
# when an edit holding it is committed.
set -euo pipefail
PACKAGE=${PLAY_PACKAGE:-com.hushos.app}
API=https://androidpublisher.googleapis.com/androidpublisher/v3/applications/$PACKAGE
UPLOAD_API=https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/$PACKAGE
PLAN=false

usage() {
    sed -n '6,8p' "$0" | sed 's/^#  */usage: /' >&2
    exit 1
}
if [[ "${1:-}" == --print-plan ]]; then
    PLAN=true
    shift
fi
COMMAND=${1:-}
case "$COMMAND" in
    upload | dry-run)
        [[ $# -eq 4 ]] || usage
        AAB=$2 VERSION=$3 CODE=$4
        [[ -s "$AAB" ]] || { echo "$AAB does not exist or is empty" >&2; exit 1; }
        ;;
    promote)
        [[ $# -eq 3 ]] || usage
        VERSION=$2 CODE=$3
        ;;
    *) usage ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "$VERSION is not a version (X.Y.Z)" >&2; exit 1; }
[[ "$CODE" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "$CODE is not a versionCode" >&2; exit 1; }
# Play Console's own naming for a release: "1.0.0 (1)".
NAME="$VERSION ($CODE)"

TOKEN=''
token() {
    if $PLAN; then
        TOKEN=plan
        return
    fi
    TOKEN=${PLAY_ACCESS_TOKEN:-}
    [[ -n "$TOKEN" ]] || {
        echo "PLAY_ACCESS_TOKEN is not set: an OAuth access token for the release service account, scope androidpublisher." >&2
        exit 1
    }
    [[ "${GITHUB_ACTIONS:-}" != true ]] || echo "::add-mask::$TOKEN"
}

# api METHOD URL [curl arguments...]: the response body on stdout; Google's error and exit 1
# on anything but 2xx. In plan mode, the request is printed and a made-up answer returned.
api() {
    local method=$1 url=$2 response status
    shift 2
    if $PLAN; then
        echo "$method $url${*:+ $*}" >&2
        plan_answer "$method" "$url"
        return
    fi
    response=$(curl -sS -X "$method" "$url" \
        -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
        -w '\n%{http_code}' "$@") || { echo "$method $url: the request did not complete" >&2; exit 1; }
    status=${response##*$'\n'}
    response=${response%$'\n'*}
    if [[ "$status" != 2?? ]]; then
        echo "$method $url: HTTP $status" >&2
        jq -r '.error | "\(.status // "") \(.message // .)"' <<< "$response" >&2 2> /dev/null || echo "$response" >&2
        exit 1
    fi
    printf '%s\n' "$response"
}

plan_answer() {
    case "$1 $2" in
        "POST $API/edits") echo '{"id":"EDIT"}' ;;
        "GET $API/edits/EDIT/bundles") echo '{"bundles":[]}' ;;
        "POST $UPLOAD_API/edits/EDIT/bundles"*)
            jq -cn --argjson code "$CODE" --arg sha "${AAB_SHA256:-}" '{versionCode: $code, sha256: $sha}'
            ;;
        "GET $API/edits/EDIT/tracks/internal")
            if [[ "$COMMAND" == promote ]]; then
                jq -cn --argjson code "$CODE" --arg name "$NAME" \
                    '{track: "internal", releases: [{name: $name, versionCodes: [($code | tostring)], status: "completed"}]}'
            else
                echo '{"track":"internal","releases":[]}'
            fi
            ;;
        "GET $API/edits/EDIT/tracks/production") echo '{"track":"production","releases":[]}' ;;
        *) echo '{}' ;;
    esac
}

EDIT=''
COMMITTED=false
# An edit left open expires on its own, but deleting it says plainly that nothing changed.
discard() {
    if [[ -n "$EDIT" ]] && ! $COMMITTED; then
        if (api DELETE "$API/edits/$EDIT") > /dev/null 2>&1; then
            echo "Deleted edit $EDIT; Google Play is unchanged." >&2
        else
            echo "Edit $EDIT was not committed (and could not be deleted; it expires): Google Play is unchanged." >&2
        fi
    fi
}
trap discard EXIT

open_edit() {
    EDIT=$(api POST "$API/edits" | jq -er .id)
}

commit_edit() {
    api POST "$API/edits/$EDIT:commit" > /dev/null
    COMMITTED=true
}

# The bundle into the open edit, unless Play already has this versionCode (a re-run after a
# commit): Play would refuse a second one, and the track is then set to the one it has.
upload_bundle() {
    local existing response uploaded sha
    existing=$(api GET "$API/edits/$EDIT/bundles" | jq --argjson code "$CODE" '[.bundles[]? | select(.versionCode == $code)] | length')
    if [[ "$existing" != 0 ]]; then
        echo "::notice title=Already on Google Play::versionCode $CODE was uploaded before; it is not uploaded again."
        return
    fi
    AAB_SHA256=$(sha256sum "$AAB" 2> /dev/null || shasum -a 256 "$AAB")
    AAB_SHA256=${AAB_SHA256%% *}
    echo "Uploading $AAB ($(wc -c < "$AAB" | tr -d ' ') bytes, SHA-256 $AAB_SHA256)"
    response=$(api POST "$UPLOAD_API/edits/$EDIT/bundles?uploadType=media" \
        -H 'Content-Type: application/octet-stream' --data-binary "@$AAB")
    uploaded=$(jq -r .versionCode <<< "$response")
    sha=$(jq -r .sha256 <<< "$response")
    [[ "$uploaded" == "$CODE" ]] || { echo "Google Play read versionCode $uploaded from the bundle, not $CODE." >&2; exit 1; }
    [[ "$sha" == "$AAB_SHA256" ]] || { echo "Google Play holds a bundle with SHA-256 $sha, not $AAB_SHA256." >&2; exit 1; }
    echo "Google Play has versionCode $CODE, SHA-256 $sha"
}

# The internal track's release for this versionCode, built on what the track already holds: a
# completed one is left exactly as it is (a re-run after the commit), so release notes written
# in Play Console since are not lost, and for anything else the notes carry over. Sets TRACK
# to the new track, or to nothing when there is nothing to change.
TRACK=''
internal_track() {
    local internal existing
    TRACK=''
    internal=$(api GET "$API/edits/$EDIT/tracks/internal")
    existing=$(jq -c --arg code "$CODE" '[.releases[]? | select((.versionCodes // []) | index($code))][0] // empty' <<< "$internal")
    if [[ -n "$existing" && "$(jq -r .status <<< "$existing")" == completed ]]; then
        echo "::notice title=Already on internal testing::$(jq -r --arg name "$NAME" '.name // $name' <<< "$existing") is already rolled out to the testers; the track is left as it is, release notes included."
        return
    fi
    TRACK=$(jq -c --arg name "$NAME" --arg code "$CODE" '{
        track: "internal",
        releases: [{name: $name, versionCodes: [$code], status: "completed"}
            + (if .releaseNotes then {releaseNotes: .releaseNotes} else {} end)]
    }' <<< "${existing:-"{}"}")
}

set_track() {
    local track=$1 body=$2
    api PUT "$API/edits/$EDIT/tracks/$track" -H 'Content-Type: application/json' --data "$body" > /dev/null
}

token
case "$COMMAND" in
    upload)
        open_edit
        upload_bundle
        # No new release notes: the manual flow writes them per release in Play Console from
        # docs/release/store-listing.md, and there is no per-version source to send.
        internal_track
        if [[ -z "$TRACK" ]]; then
            echo "Google Play internal testing already had $NAME; nothing changed."
            exit 0
        fi
        set_track internal "$TRACK"
        commit_edit
        echo "Google Play internal testing: $NAME, rolled out to the testers."
        ;;
    dry-run)
        open_edit
        upload_bundle
        internal_track
        [[ -z "$TRACK" ]] || set_track internal "$TRACK"
        api POST "$API/edits/$EDIT:validate" > /dev/null
        echo "Google Play accepted $NAME for the internal track; nothing was committed."
        ;;
    promote)
        open_edit
        internal=$(api GET "$API/edits/$EDIT/tracks/internal")
        release=$(jq -c --arg code "$CODE" '[.releases[]? | select(.versionCodes | index($code))][0] // empty' <<< "$internal")
        if [[ -z "$release" ]]; then
            echo "The internal track does not hold versionCode $CODE ($VERSION); it holds:" >&2
            jq -r '.releases[]? | "  \(.name // "unnamed"): \(.versionCodes | join(", ")) (\(.status))"' <<< "$internal" >&2
            exit 1
        fi
        status=$(jq -r .status <<< "$release")
        [[ "$status" == completed ]] || { echo "versionCode $CODE is $status on the internal track, not completed: roll it out to testers first." >&2; exit 1; }
        production=$(api GET "$API/edits/$EDIT/tracks/production")
        echo "Production before: $(jq -r '[.releases[]? | "\(.name // "unnamed") [\(.versionCodes // [] | join(","))] \(.status)"] | join("; ") | if . == "" then "nothing" else . end' <<< "$production")"
        # The internal release's name and notes (if any were written in Play Console) go with it.
        set_track production "$(jq -c --arg code "$CODE" --arg name "$NAME" '{
            track: "production",
            releases: [{name: (.name // $name), versionCodes: [$code], status: "completed"}
                + (if .releaseNotes then {releaseNotes: .releaseNotes} else {} end)]
        }' <<< "$release")"
        commit_edit
        echo "Google Play production: $(jq -r --arg name "$NAME" '.name // $name' <<< "$release"), versionCode $CODE, to 100% of users once Google's review passes."
        ;;
esac
