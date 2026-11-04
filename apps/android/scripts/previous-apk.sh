#!/usr/bin/env bash
# Downloads the APK of the highest release below a tag that has one attached, for
# check-bundle.sh to compare the phones a new bundle reaches with what the last release reached.
#
#   apps/android/scripts/previous-apk.sh v1.2.3 <directory>
#
# Prints the downloaded APK's path, or nothing when no earlier release has an APK. Only a
# confirmed absence moves it on to an older release: a release GitHub answers 404 for, or one
# whose asset list has no HushOS-X.Y.Z.apk. Any other answer (a 5xx, a refused token, no
# answer at all) or a failed download stops it, so the comparison is never quietly made with a
# staler release or skipped. Release tags come from this checkout (fetched with full history);
# GH_REPO picks the repository, as for gh.
set -euo pipefail
[[ $# -eq 2 && "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <vX.Y.Z> <directory>" >&2; exit 1; }
TAG=$1 OUT=$2
REPO=${GH_REPO:?GH_REPO is not set (owner/name)}
mkdir -p "$OUT"

# Every vX.Y.Z tag below this one, highest first.
earlier=$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | while read -r t; do
    [[ "$t" != "$TAG" && "$(printf '%s\n' "$t" "$TAG" | sort -V | tail -n 1)" == "$TAG" ]] && echo "$t"
done | sort -rV || true)

for prev in $earlier; do
    name=HushOS-${prev#v}.apk
    # Headers and body, whatever the status: gh exits 1 on a 404 as on a 503.
    response=$(gh api -i "repos/$REPO/releases/tags/$prev" 2> /dev/null) || true
    status=$(head -n 1 <<< "$response" | sed -nE 's#^HTTP/[0-9.]+ ([0-9]{3}).*#\1#p')
    status=${status:+HTTP $status}
    case "$status" in
        'HTTP 200') ;;
        'HTTP 404')
            echo "$prev has no GitHub release." >&2
            continue
            ;;
        *)
            echo "Could not look up the $prev release (${status:-no answer}); not comparing with an older one instead." >&2
            exit 1
            ;;
    esac
    body=$(awk 'body { print } /^\r?$/ { body = 1 }' <<< "$response")
    attached=$(jq -r --arg name "$name" 'any(.assets[]?; .name == $name)' <<< "$body") || {
        echo "GitHub's answer for the $prev release is not JSON." >&2
        exit 1
    }
    if [[ "$attached" != true ]]; then
        echo "$prev has no $name attached." >&2
        continue
    fi
    gh release download "$prev" -R "$REPO" -p "$name" -D "$OUT" --clobber || {
        echo "Could not download $name from $prev." >&2
        exit 1
    }
    [[ -s "$OUT/$name" ]] || { echo "$name from $prev is empty." >&2; exit 1; }
    echo "Comparing with $prev's $name." >&2
    echo "$OUT/$name"
    exit 0
done
echo "No release below $TAG has an APK attached." >&2
