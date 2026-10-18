#!/usr/bin/env bash
# The build number of the iOS and Android store builds (CFBundleVersion, versionCode): the
# number of commits in HEAD's history. Pull requests are squash-merged and main is never
# rewritten, so on main it only ever grows, and every clone with full history computes the
# same number for the same commit, on a laptop or in CI.
#
#   scripts/build-number.sh            # print it
#   scripts/build-number.sh --store    # and refuse what would break the rule: a shallow clone,
#                                      # or a commit that is not on origin/main
#
# HUSHOS_BUILD_NUMBER overrides it, for a second upload of one commit; it must still be higher
# than every earlier upload.
set -euo pipefail
if [[ -n "${HUSHOS_BUILD_NUMBER:-}" ]]; then
    [[ "$HUSHOS_BUILD_NUMBER" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "HUSHOS_BUILD_NUMBER must be a whole number from 1" >&2; exit 1; }
    echo "$HUSHOS_BUILD_NUMBER"
    exit 0
fi
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --store ]]; then
    [[ "$(git rev-parse --is-shallow-repository)" == false ]] || { echo "A shallow clone counts too few commits: run git fetch --unshallow" >&2; exit 1; }
    # A branch's count can pass the next main commit's, and the store then refuses main's build.
    git merge-base --is-ancestor HEAD origin/main 2>/dev/null || { echo "Store builds come from a commit on main: git fetch, then check out main or a release tag (v1.2.3)" >&2; exit 1; }
fi
git rev-list --count HEAD
