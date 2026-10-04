#!/usr/bin/env bash
# The local infrastructure without Docker: PostgreSQL, Mailpit and Garage, on the ports
# .env names, with their data under INFRA_DIR. CI's macOS runner has no Docker, and WebKit
# there is the engine Safari ships, so the browser suite runs against this. The binaries
# come from Homebrew (brew install postgresql@18 mailpit garage); PG_BIN, MAILPIT and
# GARAGE point elsewhere, and INFRA_SERVICES starts only some of the three.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a

dir="${INFRA_DIR:-${RUNNER_TEMP:-/tmp}/hushos-infra}"
services="${INFRA_SERVICES:-postgres mailpit garage}"
mkdir -p "$dir"

# Waits up to a minute for a command to succeed, naming the log to read if it never does.
wait_for() {
    local what=$1 log=$2
    shift 2
    for _ in $(seq 1 60); do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    echo "$what did not come up; its log:" >&2
    tail -n 40 "$log" >&2
    exit 1
}

if [[ " $services " == *" postgres "* ]]; then
    pg_bin="${PG_BIN:-$(brew --prefix postgresql@18)/bin}"
    port="${POSTGRES_PORT:-5433}"
    # Trust on the loopback only: the database lives as long as the runner.
    [ -d "$dir/postgres" ] || "$pg_bin/initdb" -D "$dir/postgres" -U "$POSTGRES_USER" --auth=trust >/dev/null
    "$pg_bin/pg_ctl" -D "$dir/postgres" -l "$dir/postgres.log" -w \
        -o "-p $port -c listen_addresses=127.0.0.1 -k $dir" start >/dev/null
    "$pg_bin/createdb" -h 127.0.0.1 -p "$port" -U "$POSTGRES_USER" "$POSTGRES_DB" 2>/dev/null || true
    echo "PostgreSQL on 127.0.0.1:$port"
fi

if [[ " $services " == *" mailpit "* ]]; then
    ui="${MAILPIT_UI_PORT:-8025}"
    nohup "${MAILPIT:-mailpit}" --smtp "127.0.0.1:${SMTP_PORT:-1025}" --listen "127.0.0.1:$ui" \
        >"$dir/mailpit.log" 2>&1 &
    wait_for Mailpit "$dir/mailpit.log" curl -sf "http://127.0.0.1:$ui/readyz"
    echo "Mailpit on 127.0.0.1:${SMTP_PORT:-1025}, inbox on 127.0.0.1:$ui"
fi

if [[ " $services " == *" garage "* ]]; then
    garage="${GARAGE:-garage}"
    s3="${STORAGE_PORT:-9000}"
    # scripts/garage.toml with the paths and ports of a machine rather than a container.
    cat >"$dir/garage.toml" <<EOF
metadata_dir = "$dir/garage/meta"
data_dir = "$dir/garage/data"
replication_factor = 1
compression_level = "none"
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "us-east-1"
api_bind_addr = "127.0.0.1:$s3"

[admin]
api_bind_addr = "127.0.0.1:3903"
EOF
    nohup "$garage" -c "$dir/garage.toml" server >"$dir/garage.log" 2>&1 &
    wait_for Garage "$dir/garage.log" "$garage" -c "$dir/garage.toml" status
    GARAGE_ADMIN_URL=http://127.0.0.1:3903 bun scripts/garage-init.ts
    echo "Garage S3 on 127.0.0.1:$s3"
fi
