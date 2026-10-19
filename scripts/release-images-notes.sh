#!/usr/bin/env bash
# Writes the "Server images" section of a GitHub release's notes: the web, worker and migrate
# images at the version tag, each as a docker pull line pinned by the digest the tag names now,
# and the upgrade steps in docs/self-hosting.md. Running it again replaces the section
# (scripts/release-notes-section.sh). .github/workflows/release.yml runs it once the version
# tags are copied; by hand it does the same for a release whose version tags exist:
#
#   scripts/release-images-notes.sh v1.2.3
#
# The images are public, so it needs no registry login; it needs docker buildx, and gh allowed
# to edit releases. GH_REPO, else GITHUB_REPOSITORY, else the origin remote names the repository.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $# -eq 1 && "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <vX.Y.Z>" >&2; exit 1; }
TAG=$1
VERSION=${TAG#v}
GH_REPO=${GH_REPO:-${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##')}}
export GH_REPO
REGISTRY=ghcr.io/$(tr '[:upper:]' '[:lower:]' <<< "$GH_REPO")

SECTION=$(mktemp)
trap 'rm -f "$SECTION"' EXIT
{
    echo '## Server images'
    echo
    echo "The web, worker and migrate images of $VERSION, pinned by digest:"
    echo
    echo '```sh'
    for image in web worker migrate; do
        ref="$REGISTRY-$image:$VERSION"
        digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' | jq -r '.digest // empty')
        [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "No digest for $ref: are the version tags copied yet?" >&2; exit 1; }
        echo "docker pull $ref@$digest"
    done
    echo '```'
    echo
    echo "To move a Compose deployment to this release, set \`HUSHOS_IMAGE_TAG=$VERSION\` and follow [Updating and backups](https://github.com/$GH_REPO/blob/$TAG/docs/self-hosting.md#updating-and-backups) in docs/self-hosting.md."
} > "$SECTION"

scripts/release-notes-section.sh "$TAG" server-images "$SECTION"
