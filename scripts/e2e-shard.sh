#!/usr/bin/env bash
# The Playwright arguments for one CI shard of a browser's suite, by measured time rather
# than Playwright's --shard, which splits by test count in file order: drive.spec.ts's many
# short tests and families.spec.ts's skipped ones made one WebKit shard take 8.5 minutes
# beside another's 3.5. Each shard but the last runs the spec files listed for it; the last
# runs every spec file the others do not list, so a new spec always runs somewhere.
#
#   scripts/e2e-shard.sh <chromium|webkit> <shard> <total>
#
# Rebalance from a run's per-test durations (the list reporter prints them) when a shard
# drifts a minute or more past the others. Each shard runs two workers, and the dev-mode
# times the lists were drawn from (2026-10-17, seconds per file) are in the comments.
set -euo pipefail

engine=${1:?engine}
shard=${2:?shard}
total=${3:?total}

case $engine in
    chromium)
        shards=(
            # 99 + 58 + 19 + 4 + 80 + 71
            'account.spec.ts catalogue.spec.ts families.spec.ts office.spec.ts reports.spec.ts sharing.spec.ts'
            # 21 + 37 + 9 + 77 + 111 + 62 + 26
            'admin-storage.spec.ts contacts.spec.ts csp.spec.ts drive.spec.ts links.spec.ts referrals.spec.ts sealed-copy.spec.ts'
            # The rest: devices 84, integrity 200, palette 26, recover 21, return 44, mobile 3.
        )
        ;;
    webkit)
        shards=(
            # 203 + 36 + 155
            'reports.spec.ts sealed-copy.spec.ts sharing.spec.ts'
            # 120 + 50 + 144 + 8 + 56
            'devices.spec.ts families.spec.ts integrity.spec.ts office.spec.ts return.spec.ts'
            # 76 + 10 + 151 + 113 + 16
            'contacts.spec.ts csp.spec.ts drive.spec.ts links.spec.ts palette.spec.ts'
            # The rest: account 88, admin-storage 18, catalogue 159, recover 32, referrals 48.
        )
        ;;
    *)
        echo "unknown engine: $engine" >&2
        exit 1
        ;;
esac

if ((total != ${#shards[@]} + 1)); then
    echo "$engine has $((${#shards[@]} + 1)) shards here and $total in the workflow; change both" >&2
    exit 1
fi
if ((shard < 1 || shard > total)); then
    echo "shard $shard is not between 1 and $total" >&2
    exit 1
fi

cd "$(dirname "$0")/../e2e"
# A listed file that no longer exists would quietly move its tests to the last shard.
for file in ${shards[*]}; do
    [[ -f $file ]] || {
        echo "e2e/$file is listed in scripts/e2e-shard.sh but does not exist" >&2
        exit 1
    }
done

list=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/e2e-shard.XXXXXX")
if ((shard < total)); then
    # shellcheck disable=SC2086
    printf '%s\n' ${shards[shard - 1]} >"$list"
    echo "--test-list=$list"
else
    # shellcheck disable=SC2086
    printf '%s\n' ${shards[*]} >"$list"
    echo "--test-list-invert=$list"
fi
