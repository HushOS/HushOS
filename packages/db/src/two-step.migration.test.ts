import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/*
 * The two-step migrations and their undo scripts (drizzle/<migration>/undo.sql), on a database
 * of their own beside the test database: every earlier migration is applied with drizzle's
 * migrator (the code `drizzle-kit migrate` runs, with its ledger), the schema is read, the
 * migrations are applied, rows are written, the undo scripts are run as an operator would run
 * them, and the schema is read again. It must be the schema from before, exactly: tables,
 * columns, defaults, constraints, indexes, triggers, functions and the migrations ledger.
 */

const TABLES = '20261112160538_two_step';
const GUARD = '20261112174853_two_step_session_guard';
const READERS = '20261113181124_two_step_key_readers';
const PASSKEYS = '20261113195154_two_step_passkeys';
const DEVICE = '20261113232239_two_step_device';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const undo = (migration: string) =>
    readFileSync(new URL(`../drizzle/${migration}/undo.sql`, import.meta.url), 'utf8');

const scratchUrl = new URL(process.env.DATABASE_URL!);
const scratchName = `${scratchUrl.pathname.slice(1)}_undo`;
scratchUrl.pathname = `/${scratchName}`;

/* Creates or drops the scratch database, from the test database's own connection. */
async function scratchDatabase(action: 'create' | 'drop') {
    // The name is built from the test database's; refuse anything that is not that shape.
    if (!/^[a-z0-9_]+_test_[a-z0-9]+_undo$/.test(scratchName))
        throw new Error(`Refusing to touch database "${scratchName}".`);
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
        await admin.query(`drop database if exists "${scratchName}" with (force)`);
        if (action === 'create') await admin.query(`create database "${scratchName}"`);
    } finally {
        await admin.end();
    }
}

/* Everything the migrations could have changed, in a fixed order. */
async function schemaOf(client: Client) {
    const read = async (text: string) => (await client.query(text)).rows;
    return {
        columns: await read(
            `select table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
             from information_schema.columns where table_schema = 'public'
             order by table_name, ordinal_position`,
        ),
        constraints: await read(
            `select c.conrelid::regclass::text as on_table, c.conname, c.contype, c.convalidated,
                    pg_get_constraintdef(c.oid) as definition
             from pg_constraint c join pg_namespace n on n.oid = c.connamespace
             where n.nspname = 'public' order by 1, 2`,
        ),
        indexes: await read(
            `select tablename, indexname, indexdef from pg_indexes
             where schemaname = 'public' order by tablename, indexname`,
        ),
        triggers: await read(
            `select t.tgrelid::regclass::text as on_table, t.tgname, pg_get_triggerdef(t.oid) as definition
             from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and not t.tgisinternal order by 1, 2`,
        ),
        functions: await read(
            `select p.proname, pg_get_functiondef(p.oid) as definition
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' order by 1`,
        ),
        ledger: (
            await read(`select name from drizzle.__drizzle_migrations order by created_at, id`)
        ).map((row) => row.name as string),
    };
}

/* A schema without its columns' positions, for comparing one where a column was dropped and added again. */
function unnumbered(schema: Awaited<ReturnType<typeof schemaOf>>) {
    return {
        ...schema,
        columns: schema.columns.map(({ ordinal_position: _position, ...column }) => column),
    };
}

const all = readMigrationFiles({ migrationsFolder });
const upTo = (name: string) => all.filter((migration) => (migration.name ?? '') <= name);
const earlier = all.filter((migration) => (migration.name ?? '') < TABLES);

describe('the two-step migrations and their undo scripts', () => {
    const scratch = drizzle(scratchUrl.toString());
    const client = new Client({ connectionString: scratchUrl.toString() });

    beforeAll(async () => {
        await scratchDatabase('create');
        await client.connect();
    }, 60_000);

    afterAll(async () => {
        await client.end();
        await scratch.$client.end();
        await scratchDatabase('drop');
    }, 60_000);

    /* Runs an undo script as `psql -f` does: the file as it is, which opens and commits its own transaction. */
    async function run(script: string, on: Client = client) {
        try {
            await on.query(script);
        } catch (error) {
            await on.query('rollback');
            throw error;
        }
    }

    const insertSession = (userId: string, deviceId: string, stamped: boolean) =>
        client.query(
            `insert into sessions (user_id, device_id, token_hash, credential_version, expires_at${stamped ? ', two_step_at' : ''})
             values ($1, $2, $3, 1, now() + interval '1 hour'${stamped ? ', now()' : ''})`,
            [userId, deviceId, randomBytes(32)],
        );
    const insertDevice = async (userId: string) =>
        (
            await client.query<{ id: string }>(
                `insert into account_devices (user_id, approved_by, approved_at) values ($1, 'password', now()) returning id`,
                [userId],
            )
        ).rows[0]!.id;

    test('undo takes the schema back to exactly what it was, keeps the rows that were there, and the migrations apply again', async () => {
        // The two migrations are the newest this test knows how to take back, one after the other.
        const names = all.map((migration) => migration.name);
        expect(names.indexOf(GUARD)).toBe(names.indexOf(TABLES) + 1);
        expect(earlier.length).toBeGreaterThan(0);

        // Before: every earlier migration, and an account with a device and a session.
        await migrate(earlier, scratch, { migrationsFolder });
        const before = await schemaOf(client);
        expect(before.ledger).toEqual(earlier.map((migration) => migration.name));
        const userId = randomUUID();
        await client.query(
            `insert into users (id, name, email, normalized_email, email_verified_at) values ($1, 'Maya', 'maya@hushos.test', 'maya@hushos.test', now())`,
            [userId],
        );
        const laptop = await insertDevice(userId);
        await insertSession(userId, laptop, false);

        // After: the migrations ran over those rows.
        await migrate(upTo(GUARD), scratch, { migrationsFolder });
        const after = await schemaOf(client);
        expect(after.ledger).toEqual([...before.ledger, TABLES, GUARD]);
        // The repository's first trigger: there was none before.
        expect(before.triggers).toEqual([]);
        expect(after.triggers.map((trigger) => trigger.tgname)).toEqual([
            'sessions_two_step_guard',
        ]);
        const added = after.columns.filter(
            (column) =>
                !before.columns.some(
                    (old) =>
                        old.table_name === column.table_name &&
                        old.column_name === column.column_name,
                ),
        );
        expect([...new Set(added.map((column) => column.table_name as string))].sort()).toEqual([
            'account_devices',
            'account_security_events',
            'sessions',
            'two_step_attempts',
            'two_step_backup_codes',
            'two_step_factors',
            'two_step_state',
        ]);

        // Rows of every new kind, so the undo runs on a database that used the feature.
        const factorId = randomUUID();
        await client.query(
            `insert into two_step_factors (id, user_id, kind, confirmed_at, totp_key_id, totp_nonce, totp_secret, totp_last_step)
             values ($1, $2, 'totp', now(), $3, $4, $5, 1000)`,
            [factorId, userId, randomBytes(8), randomBytes(24), randomBytes(36)],
        );
        await client.query(
            `insert into two_step_state (user_id, webauthn_user_handle, backup_code_salt) values ($1, $2, $3)`,
            [userId, randomBytes(32), randomBytes(16)],
        );
        await client.query(
            `insert into two_step_backup_codes (user_id, code_hash, key_id) values ($1, $2, $3)`,
            [userId, randomBytes(32), randomBytes(8)],
        );
        await client.query(
            `insert into two_step_attempts (token_hash, user_id, purpose, credential_version, device_id, expires_at)
             values ($1, $2, 'login', 1, $3, now() + interval '5 minutes')`,
            [randomBytes(32), userId, laptop],
        );
        await client.query(
            `insert into account_security_events (user_id, kind, method, device_id, device_kind) values ($1, 'sign-in', 'totp', $2, 'web')`,
            [userId, laptop],
        );
        await client.query(
            `insert into opaque_login_attempts (purpose, session_token_hash, token_hash, user_id, credential_version, profile_version, server_state, expires_at)
             values ('two-step', $1, $2, $3, 1, 1, 'state', now() + interval '5 minutes')`,
            [randomBytes(32), randomBytes(32), userId],
        );
        await client.query(`update account_devices set two_step_failures = 3 where id = $1`, [
            laptop,
        ]);
        const phone = await insertDevice(userId);
        await insertSession(userId, phone, true);
        // The guard is live here: the account has a confirmed factor.
        const tablet = await insertDevice(userId);
        await expect(insertSession(userId, tablet, false)).rejects.toMatchObject({
            code: '23514',
            constraint: 'sessions_two_step_guard',
        });

        // Out of order, the tables' undo stops and changes nothing: the guard reads a table it drops.
        await expect(run(undo(TABLES))).rejects.toMatchObject({
            message: 'HushOS: the two-step guard is still on "sessions".',
        });
        expect(await schemaOf(client)).toEqual(after);
        expect((await client.query('select 1 from two_step_factors')).rowCount).toBe(1);

        // The guard's undo: only the trigger, its function and its ledger row go.
        await run(undo(GUARD));
        const unguarded = await schemaOf(client);
        expect(unguarded).toEqual({
            ...after,
            triggers: before.triggers,
            functions: before.functions,
            ledger: [...before.ledger, TABLES],
        });
        // Which is what it costs: the password alone opens a session for this account again.
        await insertSession(userId, tablet, false);

        // The tables' undo deletes what turns the step off for an account that has it on, so
        // it stops, changing nothing, until the session says that is meant.
        await expect(run(undo(TABLES))).rejects.toMatchObject({
            message:
                'HushOS: 1 account(s) have two-step sign-in on, and this deletes their methods and backup codes.',
            hint: expect.stringContaining('hushos.delete_two_step=yes'),
        });
        expect(await schemaOf(client)).toEqual(unguarded);
        expect((await client.query('select 1 from two_step_factors')).rowCount).toBe(1);
        expect((await client.query('select 1 from two_step_backup_codes')).rowCount).toBe(1);
        // Any other value is not the acknowledgement.
        await client.query(`set hushos.delete_two_step = 'no'`);
        await expect(run(undo(TABLES))).rejects.toMatchObject({
            message: expect.stringContaining('1 account(s) have two-step sign-in on'),
        });
        expect(await schemaOf(client)).toEqual(unguarded);

        // Acknowledged (PGOPTIONS="-c hushos.delete_two_step=yes"): the schema and the ledger
        // are what they were before either migration.
        await client.query('reset hushos.delete_two_step');
        const acknowledged = new Client({
            connectionString: scratchUrl.toString(),
            options: '-c hushos.delete_two_step=yes',
        });
        await acknowledged.connect();
        try {
            await run(undo(TABLES), acknowledged);
        } finally {
            await acknowledged.end();
        }
        expect(await schemaOf(client)).toEqual(before);
        // The rows that were there before, and the sessions made since, are still there.
        expect((await client.query('select 1 from users where id = $1', [userId])).rowCount).toBe(
            1,
        );
        expect((await client.query('select 1 from account_devices')).rowCount).toBe(3);
        expect((await client.query('select 1 from sessions')).rowCount).toBe(3);
        expect((await client.query('select 1 from opaque_login_attempts')).rowCount).toBe(0);

        // Undone, the same release migrates again to the same schema: the ledger rows went with it.
        // Only the two re-added columns' positions differ: Postgres never reuses a dropped column's number.
        await migrate(upTo(GUARD), scratch, { migrationsFolder });
        const again = await schemaOf(client);
        expect(unnumbered(again)).toEqual(unnumbered(after));

        // An undo script run twice fails whole instead of half-applying.
        await run(undo(GUARD));
        await expect(run(undo(GUARD))).rejects.toMatchObject({ code: '42704' });
        const unguardedAgain = {
            ...again,
            triggers: before.triggers,
            functions: before.functions,
            ledger: [...before.ledger, TABLES],
        };
        expect(await schemaOf(client)).toEqual(unguardedAgain);

        // A method being confirmed while the undo runs: the undo waits behind it, and then
        // counts it. Counted before the lock, it would be dropped without anyone having said so.
        const factor = `insert into two_step_factors (user_id, kind, confirmed_at, totp_key_id, totp_nonce, totp_secret, totp_last_step)
             values ($1, 'totp', $2, $3, $4, $5, $6)`;
        const confirming = new Client({ connectionString: scratchUrl.toString() });
        await confirming.connect();
        try {
            await confirming.query('begin');
            await confirming.query(factor, [
                userId,
                new Date(),
                randomBytes(8),
                randomBytes(24),
                randomBytes(36),
                1000,
            ]);
            const undoing = run(undo(TABLES)).then(
                () => null,
                (error: Error) => error,
            );
            await expect
                .poll(
                    async () => {
                        await confirming.query('select pg_stat_clear_snapshot()');
                        const waiting = await confirming.query(
                            `select 1 from pg_stat_activity where datname = current_database()
                             and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
                        );
                        return waiting.rowCount;
                    },
                    { timeout: 10_000 },
                )
                .toBe(1);
            await confirming.query('commit');
            expect(await undoing).toMatchObject({
                message: expect.stringContaining('1 account(s) have two-step sign-in on'),
            });
        } finally {
            await confirming.end();
        }
        expect(await schemaOf(client)).toEqual(unguardedAgain);
        expect((await client.query('select 1 from two_step_factors')).rowCount).toBe(1);

        // The acknowledgement set in the session itself, for a pooler that takes no startup
        // options: psql -c "set hushos.delete_two_step = 'yes'" -f undo.sql.
        await client.query(`set hushos.delete_two_step = 'yes'`);
        await run(undo(TABLES));
        await client.query('reset hushos.delete_two_step');
        expect(await schemaOf(client)).toEqual(before);

        // With no account on the step (a pending method is not one), the tables' undo asks for nothing.
        await migrate(upTo(GUARD), scratch, { migrationsFolder });
        await run(undo(GUARD));
        await client.query(factor, [
            userId,
            null,
            randomBytes(8),
            randomBytes(24),
            randomBytes(36),
            0,
        ]);
        await run(undo(TABLES));
        expect(await schemaOf(client)).toEqual(before);
        await expect(run(undo(TABLES))).rejects.toMatchObject({ code: '42P01' });
        expect(await schemaOf(client)).toEqual(before);
    }, 180_000);

    test('the passkeys migration makes the app the default for accounts that have one, and its undo takes back only what it added', async () => {
        // Before: everything up to the release before this one, an account with the step on by an app, one whose
        // only method is a key, and one that started setting up and never confirmed.
        await migrate(upTo(READERS), scratch, { migrationsFolder });
        const before = await schemaOf(client);
        const account = async (email: string) => {
            const id = randomUUID();
            await client.query(
                `insert into users (id, name, email, normalized_email, email_verified_at) values ($1, 'Someone', $2, $2, now())`,
                [id, email],
            );
            await client.query(
                `insert into two_step_state (user_id, webauthn_user_handle, backup_code_salt) values ($1, $2, $3)`,
                [id, randomBytes(32), randomBytes(16)],
            );
            return id;
        };
        const app = (userId: string, confirmed: boolean) =>
            client.query(
                `insert into two_step_factors (user_id, kind, confirmed_at, totp_key_id, totp_nonce, totp_secret, totp_last_step)
                 values ($1, 'totp', $2, $3, $4, $5, $6)`,
                [
                    userId,
                    confirmed ? new Date() : null,
                    randomBytes(8),
                    randomBytes(24),
                    randomBytes(36),
                    confirmed ? 1000 : 0,
                ],
            );
        const withApp = await account('app@hushos.test');
        await app(withApp, true);
        const withKey = await account('key@hushos.test');
        await client.query(
            `insert into two_step_factors (user_id, kind, name, confirmed_at, credential_id, public_key, sign_count, transports, backup_eligible, backup_state)
             values ($1, 'webauthn', 'Security key', now(), $2, $3, 0, '{usb}', false, false)`,
            [withKey, randomBytes(32), randomBytes(77)],
        );
        const pending = await account('pending@hushos.test');
        await app(pending, false);
        await client.query(
            `insert into notification_events (user_id, kind) values ($1, 'two-step-on')`,
            [withApp],
        );
        // The kinds this migration adds are refused until it has run.
        const keyEvent = `insert into notification_events (user_id, kind) values ($1, 'two-step-key-added')`;
        await expect(client.query(keyEvent, [withKey])).rejects.toMatchObject({
            constraint: 'notification_events_kind_valid',
        });

        await migrate(upTo(PASSKEYS), scratch, { migrationsFolder });
        const after = await schemaOf(client);
        expect(after.ledger).toEqual([...before.ledger, PASSKEYS]);
        const defaults = await client.query<{ user_id: string; default_kind: string | null }>(
            `select user_id, default_kind from two_step_state`,
        );
        const defaultOf = (userId: string) =>
            defaults.rows.find((row) => row.user_id === userId)?.default_kind;
        // The first method turned on is the default: for every account today, that was its app.
        expect(defaultOf(withApp)).toBe('totp');
        // No confirmed app, no default written: the order decides (a key first).
        expect(defaultOf(withKey)).toBeNull();
        expect(defaultOf(pending)).toBeNull();
        await expect(
            client.query(`update two_step_state set default_kind = 'sms' where user_id = $1`, [
                withApp,
            ]),
        ).rejects.toMatchObject({ constraint: 'two_step_state_default_valid' });

        // Rows of what it added, so the undo runs on a database that used it.
        await client.query(keyEvent, [withKey]);
        await client.query(
            `insert into two_step_key_registrations (token_hash, user_id, session_token_hash, credential_version, challenge, expires_at)
             values ($1, $2, $3, 1, $4, now() + interval '5 minutes')`,
            [randomBytes(32), withKey, randomBytes(32), randomBytes(32)],
        );

        await run(undo(PASSKEYS));
        expect(await schemaOf(client)).toEqual(before);
        // The keys themselves stay, so the session guard still counts them; only the events an
        // older release cannot serve are gone.
        expect(
            (await client.query(`select 1 from two_step_factors where kind = 'webauthn'`)).rowCount,
        ).toBe(1);
        expect(
            (await client.query(`select kind from notification_events order by seq`)).rows,
        ).toEqual([{ kind: 'two-step-on' }]);
        const tablet = await insertDevice(withKey);
        await expect(insertSession(withKey, tablet, false)).rejects.toMatchObject({
            constraint: 'sessions_two_step_guard',
        });

        // Undone, the same release migrates again to the same schema, and is taken back again.
        await migrate(upTo(PASSKEYS), scratch, { migrationsFolder });
        expect(unnumbered(await schemaOf(client))).toEqual(unnumbered(after));
        await run(undo(PASSKEYS));
        // Run twice, it fails whole (the column is gone) instead of half-applying.
        await expect(run(undo(PASSKEYS))).rejects.toMatchObject({ code: '42703' });
        expect(await schemaOf(client)).toEqual(before);
    }, 180_000);

    test('the device migration takes another device as a method, and its undo asks before it turns anyone’s step off', async () => {
        // Before: everything up to passkeys, an account with an app and one with nothing yet.
        await migrate(upTo(PASSKEYS), scratch, { migrationsFolder });
        const before = await schemaOf(client);
        const account = async (email: string) => {
            const id = randomUUID();
            await client.query(
                `insert into users (id, name, email, normalized_email, email_verified_at) values ($1, 'Someone', $2, $2, now())`,
                [id, email],
            );
            await client.query(
                `insert into two_step_state (user_id, webauthn_user_handle, backup_code_salt) values ($1, $2, $3)`,
                [id, randomBytes(32), randomBytes(16)],
            );
            return id;
        };
        const both = await account('both@hushos.test');
        await client.query(
            `insert into two_step_factors (user_id, kind, confirmed_at, totp_key_id, totp_nonce, totp_secret, totp_last_step)
             values ($1, 'totp', now(), $2, $3, $4, 1000)`,
            [both, randomBytes(8), randomBytes(24), randomBytes(36)],
        );
        const only = await account('only@hushos.test');
        const deviceFactor = `insert into two_step_factors (user_id, kind, confirmed_at) values ($1, 'device', now())`;
        // Until the migration has run, the kind is refused everywhere it could be written.
        await expect(client.query(deviceFactor, [only])).rejects.toMatchObject({
            constraint: 'two_step_factors_kind_valid',
        });
        const event = `insert into notification_events (user_id, kind) values ($1, 'approval-request')`;
        await expect(client.query(event, [only])).rejects.toMatchObject({
            constraint: 'notification_events_kind_valid',
        });

        await migrate(upTo(DEVICE), scratch, { migrationsFolder });
        const after = await schemaOf(client);
        expect(after.ledger).toEqual([...before.ledger, DEVICE]);
        for (const userId of [both, only]) {
            await client.query(deviceFactor, [userId]);
            await client.query(
                `insert into two_step_backup_codes (user_id, code_hash, key_id) values ($1, $2, $3)`,
                [userId, randomBytes(32), randomBytes(8)],
            );
        }
        // One per account, pending or confirmed; and it carries no name.
        await expect(
            client.query(`insert into two_step_factors (user_id, kind) values ($1, 'device')`, [
                only,
            ]),
        ).rejects.toMatchObject({ constraint: 'two_step_factors_one_device_idx' });
        await expect(
            client.query(`update two_step_factors set name = 'Phone' where kind = 'device'`),
        ).rejects.toMatchObject({ constraint: 'two_step_factors_device_valid' });
        await client.query(
            `update two_step_state set default_kind = 'device' where user_id = any($1)`,
            [[both, only]],
        );
        await client.query(event, [only]);
        await client.query(
            `insert into account_security_events (user_id, kind, method) values ($1, 'sign-in', 'device')`,
            [only],
        );
        const laptop = await insertDevice(only);
        await insertSession(only, laptop, true);
        const base = `user_id, token_hash, purpose, class, commitment, expires_at, state`;
        const values = `$1, $2, 'login', 'unknown', $3, now() + interval '5 minutes'`;
        const row = () => [only, randomBytes(32), randomBytes(32)];
        await client.query(
            `insert into two_step_device_requests (${base}) values (${values}, 'waiting')`,
            row(),
        );
        // Nothing is revealed before a device opened, and nothing approved without a signature.
        await expect(
            client.query(
                `insert into two_step_device_requests (${base}, device_key, nonce) values (${values}, 'waiting', $4, $5)`,
                [...row(), randomBytes(32), randomBytes(32)],
            ),
        ).rejects.toMatchObject({ constraint: 'two_step_device_requests_state_valid' });
        await expect(
            client.query(
                `insert into two_step_device_requests (${base}, approver_device_id, approver_key, device_key, nonce) values (${values}, 'approved', $4, $5, $6, $7)`,
                [...row(), laptop, randomBytes(32), randomBytes(32), randomBytes(32)],
            ),
        ).rejects.toMatchObject({ constraint: 'two_step_device_requests_state_valid' });

        // One account has another device as its only method: the undo stops and changes nothing.
        await expect(run(undo(DEVICE))).rejects.toMatchObject({
            message: expect.stringContaining('1 account(s) have another device as their only'),
        });
        expect(await schemaOf(client)).toEqual(after);
        expect(
            (await client.query(`select 1 from two_step_factors where kind = 'device'`)).rowCount,
        ).toBe(2);

        const acknowledged = new Client({
            connectionString: scratchUrl.toString(),
            options: '-c hushos.delete_two_step=yes',
        });
        await acknowledged.connect();
        try {
            await run(undo(DEVICE), acknowledged);
        } finally {
            await acknowledged.end();
        }
        expect(await schemaOf(client)).toEqual(before);
        // The app stays, and with it that account's step and its codes.
        const mine = [both, only];
        expect(
            (
                await client.query(
                    `select user_id, kind from two_step_factors where user_id = any($1)`,
                    [mine],
                )
            ).rows,
        ).toEqual([{ user_id: both, kind: 'totp' }]);
        expect(
            (
                await client.query(
                    `select user_id from two_step_backup_codes where user_id = any($1)`,
                    [mine],
                )
            ).rows,
        ).toEqual([{ user_id: both }]);
        expect(
            (
                await client.query(
                    `select default_kind from two_step_state where user_id = any($1)`,
                    [mine],
                )
            ).rows.map((state) => state.default_kind),
        ).toEqual([null, null]);
        // The account that had only another device has no step left: its session keeps no stamp,
        // and the guard no longer refuses a password-only session for it.
        expect(
            (await client.query(`select two_step_at from sessions where user_id = $1`, [only]))
                .rows,
        ).toEqual([{ two_step_at: null }]);
        await insertSession(only, await insertDevice(only), false);
        // The log line stays, without a method an older release cannot serve.
        expect(
            (
                await client.query(
                    `select kind, method from account_security_events where user_id = $1`,
                    [only],
                )
            ).rows,
        ).toEqual([{ kind: 'sign-in', method: null }]);
        expect(
            (await client.query(`select 1 from notification_events where user_id = $1`, [only]))
                .rowCount,
        ).toBe(0);

        // Undone, the same release migrates again to the same schema; run twice, the undo fails whole.
        await migrate(upTo(DEVICE), scratch, { migrationsFolder });
        expect(unnumbered(await schemaOf(client))).toEqual(unnumbered(after));
        await run(undo(DEVICE));
        await expect(run(undo(DEVICE))).rejects.toMatchObject({ code: '42704' });
        expect(await schemaOf(client)).toEqual(before);
    }, 180_000);
});
