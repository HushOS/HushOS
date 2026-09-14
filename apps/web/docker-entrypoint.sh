#!/bin/sh
set -eu

if [ -n "${MIGRATION_DATABASE_URL_FILE:-}" ]; then
    if [ "$(id -u)" != 0 ]; then
        echo 'Startup migrations require a root-owned secret and a root entrypoint.' >&2
        exit 1
    fi
    if [ "$(stat -c '%u:%a' "$MIGRATION_DATABASE_URL_FILE")" != "0:400" ]; then
        echo 'The startup migration secret must be owned by root with mode 0400.' >&2
        exit 1
    fi
    (
        export MIGRATION_DATABASE_URL="$(cat "$MIGRATION_DATABASE_URL_FILE")"
        cd /app/packages/db
        bun run db:migrate
    )
fi

unset MIGRATION_DATABASE_URL MIGRATION_DATABASE_URL_FILE

if [ "$(id -u)" = 0 ]; then
    exec setpriv --reuid=bun --regid=bun --clear-groups --no-new-privs --bounding-set=-all "$@"
fi
exec "$@"
