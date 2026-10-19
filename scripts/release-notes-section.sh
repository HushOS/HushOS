#!/usr/bin/env bash
# Writes one section into a GitHub release's notes, between marker comments, below
# release-please's changelog. A release that already has the section gets it replaced in place,
# so running again never repeats it; the changelog and every other section are left as they are.
# Sections keep the order below whichever is written first.
#
#   scripts/release-notes-section.sh v1.2.3 server-images section.md
#
# Used by .github/workflows/release.yml (server-images, through scripts/release-images-notes.sh)
# and apps/android/scripts/release-apk.sh (apps). GH_REPO picks the repository, as for gh.
set -euo pipefail
ORDER=(server-images apps)

[[ $# -eq 3 ]] || { echo "usage: $0 <vX.Y.Z> <section name: ${ORDER[*]}> <section file>" >&2; exit 1; }
TAG=$1 NAME=$2 SECTION=$3
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "$TAG is not a release tag (vX.Y.Z)" >&2; exit 1; }
[[ -s "$SECTION" ]] || { echo "$SECTION is empty or missing" >&2; exit 1; }
marker() { printf '<!-- hushos:%s -->' "$1"; }
closing() { printf '<!-- /hushos:%s -->' "$1"; }

# The first section after this one that the notes already hold: a new section goes above it.
following=()
seen=false
for name in "${ORDER[@]}"; do
    if [[ "$name" == "$NAME" ]]; then seen=true; elif $seen; then following+=("$(marker "$name")"); fi
done
$seen || { echo "Unknown section $NAME (known: ${ORDER[*]})" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# One trailing newline, however the notes were last saved, so a rewrite never grows them.
gh release view "$TAG" --json body --jq .body | tr -d '\r' | perl -0pe 's/\n*\z/\n/' > "$WORK/body"

# A marker without its closing line would drop everything below it: refuse instead.
starts=$(grep -cxF "$(marker "$NAME")" "$WORK/body" || true)
ends=$(grep -cxF "$(closing "$NAME")" "$WORK/body" || true)
if [[ "$starts" != "$ends" || "$starts" -gt 1 ]]; then
    echo "The $TAG notes hold $starts opening and $ends closing $NAME markers; fix them by hand first." >&2
    exit 1
fi
next=''
for candidate in ${following[@]+"${following[@]}"}; do
    if grep -qxF "$candidate" "$WORK/body"; then next=$candidate; break; fi
done

# Blank lines around the content, so a comment line never joins a list or a paragraph.
{
    marker "$NAME"
    printf '\n\n'
    perl -0pe 's/\n*\z/\n/' "$SECTION"
    echo
    closing "$NAME"
    echo
} > "$WORK/block"

awk -v start="$(marker "$NAME")" -v end="$(closing "$NAME")" -v next_="$next" -v block="$WORK/block" '
    function emit(   line) { while ((getline line < block) > 0) print line; close(block); done = 1 }
    skipping { if ($0 == end) skipping = 0; next }
    $0 == start { emit(); skipping = 1; next }
    !done && next_ != "" && $0 == next_ { emit(); print "" }
    { print }
    END { if (!done) { print ""; emit() } }
' "$WORK/body" > "$WORK/notes"

if cmp -s "$WORK/body" "$WORK/notes"; then
    echo "The $TAG notes already hold this $NAME section."
    exit 0
fi
gh release edit "$TAG" --notes-file "$WORK/notes" > /dev/null
echo "Wrote the $NAME section into the $TAG notes."
