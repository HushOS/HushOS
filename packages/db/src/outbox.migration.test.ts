import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '../test/helpers';
import { AFTER_MIGRATE, pendingAfterMigrate, runAfterMigrate } from './after-migrate';

/*
 * The outbox migration and the step that runs after it, as a deployment runs
 * them: against a database migrated to the stores release, holding rows that
 * release wrote. A scratch database of its own. What must hold
 * (docs/company-storage-design.md 8.4, 11.1): every outbox row survives under
 * the new key; nothing on the big tables is rewritten, and no row is read under
 * the migration's locks to check a constraint; an insert that names no store
 * now fails instead of meaning the environment's primary; a container of the
 * stores release keeps working beside the new ones; and afterwards every
 * constraint is validated and the index exists, without a lock that blocks a
 * read or a write.
 */

const MIGRATION = '20261110025847_storage_outbox';
const PRIMARY = '00000000-0000-4000-8000-000000000001';

const testUrl = new URL(process.env.DATABASE_URL!);
const scratchName = `${testUrl.pathname.slice(1)}_outbox_migration`;
if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unexpected test database name.');
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;

let admin: Client;
let pg: Client;
const query = (text: string, params?: unknown[]) => pg.query(text, params);

function statementsOf(name: string) {
    return readFileSync(new URL(`../drizzle/${name}/migration.sql`, import.meta.url), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.replace(/^--.*$/gm, '').trim())
        .filter(Boolean);
}

/* One migration in one transaction, as drizzle applies it. */
async function migrate(name: string) {
    await pg.query('begin');
    for (const statement of statementsOf(name)) await pg.query(statement);
    await pg.query('commit');
}

async function sqlState(work: () => Promise<unknown>) {
    try {
        await work();
        return null;
    } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
    }
}

async function relfilenodes() {
    const rows = await pg.query<{ relname: string; relfilenode: string }>(
        `select relname, relfilenode::text from pg_class where relname in ('drive_objects', 'drive_uploads', 'drive_object_deletions') order by relname`,
    );
    return rows.rows.map((row) => `${row.relname}:${row.relfilenode}`).join(',');
}

const NEW_CONSTRAINTS = [
    'drive_object_deletions_backup_store_id_object_stores_id_fkey',
    'drive_object_deletions_hold_valid',
    'drive_object_deletions_reason_valid',
    'drive_object_deletions_values_valid',
    'drive_objects_backup_store_id_object_stores_id_fkey',
];

async function validity(names: string[]) {
    const rows = await pg.query<{ conname: string; convalidated: boolean }>(
        `select conname, convalidated from pg_constraint where conname = any($1) order by conname`,
        [names],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.conname, row.convalidated]));
}

/*
 * What a container of the stores release writes, in its own words: every row
 * names its store, and no column of the outbox migration is named.
 */
async function writeAsStoresRelease() {
    const workspace = await pg.query<{ id: string }>(
        `insert into workspaces (owner_kind) values ('personal') returning id`,
    );
    const workspaceId = workspace.rows[0]!.id;
    const rootId = randomUUID();
    const nodeId = randomUUID();
    const objectId = randomUUID();
    const versionId = randomUUID();
    const node = `insert into drive_nodes (id, workspace_id, parent_id, kind, key_epoch, parent_key_epoch, key_envelope, metadata_envelope) values ($1, $2, $3, $4, 1, 1, $5, $6)`;
    await pg.query(node, [rootId, workspaceId, null, 'folder', randomBytes(72), randomBytes(296)]);
    await pg.query(node, [nodeId, workspaceId, rootId, 'file', randomBytes(72), randomBytes(296)]);
    await pg.query(
        `insert into drive_objects (id, workspace_id, object_key, store_id, content_suite, chunk_size, chunk_count, content_nonce, ciphertext_size, status, replicated_at) values ($1, $2, $3, $4, 3, 8388608, 1, $5, 4096, 'ready', now())`,
        [objectId, workspaceId, `ws/${workspaceId}/${objectId}`, PRIMARY, randomBytes(16)],
    );
    await pg.query(
        `insert into file_versions (id, node_id, workspace_id, object_id, content_key_envelope, status) values ($1, $2, $3, $4, $5, 'ready')`,
        [versionId, nodeId, workspaceId, objectId, randomBytes(84)],
    );
    const upload = await pg.query<{ id: string }>(
        `insert into drive_uploads (workspace_id, node_id, version_id, object_id, object_key, key_epoch, new_node, store_id, multipart_id, reserved_bytes, expires_at) values ($1, $2, $3, $4, $5, 1, true, $6, null, 4096, now() + interval '1 day') returning id`,
        [workspaceId, nodeId, versionId, objectId, `ws/${workspaceId}/${objectId}`, PRIMARY],
    );
    return { workspaceId, nodeId, objectId, versionId, uploadId: upload.rows[0]!.id };
}

/* Its retire, statement for statement: the object row replaced by an outbox row. */
async function retireAsStoresRelease(objectId: string) {
    await pg.query(
        `with gone as (delete from drive_objects where id = $1 returning id, workspace_id, object_key, store_id, status, replicated_at)
         insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated)
         select id, workspace_id, object_key, store_id, status = 'ready', replicated_at is not null from gone
         on conflict do nothing`,
        [objectId],
    );
}

const before = {
    workspaceId: '',
    objectId: '',
    uploadId: '',
    relfilenodes: '',
    outbox: [] as Record<string, unknown>[],
};
const outboxRows = async () =>
    (
        await pg.query(
            `select object_id, workspace_id, object_key, store_id, published, replicated, primary_deleted_at, delete_replica_after, done_at, created_at from drive_object_deletions order by object_key`,
        )
    ).rows;

beforeAll(async () => {
    admin = new Client({ connectionString: testUrl.toString() });
    await admin.connect();
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
    await admin.query(`create database "${scratchName}"`);
    pg = new Client({ connectionString: scratchUrl.toString() });
    await pg.connect();
    const earlier = readdirSync(new URL('../drizzle', import.meta.url))
        .filter((name) => /^\d{14}_/.test(name) && name < MIGRATION)
        .sort();
    for (const name of earlier) await migrate(name);

    const written = await writeAsStoresRelease();
    // The outbox in every state that release leaves a row in. One was queued by a container
    // older still, which named no store and got the default.
    const row = (suffix: string) => [
        randomUUID(),
        written.workspaceId,
        `ws/${written.workspaceId}/${suffix}`,
    ];
    await pg.query(
        `insert into drive_object_deletions (object_id, workspace_id, object_key, published) values ($1, $2, $3, true)`,
        row('a-waiting-unnamed'),
    );
    await pg.query(
        `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated) values ($1, $2, $3, '${PRIMARY}', true, true)`,
        row('b-replicated'),
    );
    await pg.query(
        `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated, primary_deleted_at, delete_replica_after) values ($1, $2, $3, '${PRIMARY}', true, true, now() - interval '1 day', now() + interval '29 days')`,
        row('c-replica-pending'),
    );
    await pg.query(
        `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, primary_deleted_at, done_at) values ($1, $2, $3, '${PRIMARY}', false, now() - interval '90 days', now() - interval '90 days')`,
        row('d-finished'),
    );
    await pg.query(`insert into drive_sweeps (name, cursor) values ('orphans', 'ws/abc/def')`);
    Object.assign(before, written, {
        relfilenodes: await relfilenodes(),
        outbox: await outboxRows(),
    });
    await migrate(MIGRATION);
}, 120_000);

// Dropping a database checkpoints first, which takes seconds on a busy machine.
afterAll(async () => {
    await pg?.end();
    await admin?.query(`drop database if exists "${scratchName}" with (force)`);
    await admin?.end();
    await closeDatabase();
}, 120_000);

describe('what the migration leaves', () => {
    test('every outbox row from before, unchanged, each a purge with nothing held or left', async () => {
        expect(await outboxRows()).toEqual(before.outbox);
        expect(before.outbox).toHaveLength(4);
        const added = await pg.query(
            `select distinct reason, backup_store_id, export_store_id, export_last_seq, held_by_move, not_before, backup_left, attention, failures, failed_at from drive_object_deletions`,
        );
        expect(added.rows).toEqual([
            {
                reason: 'purged',
                backup_store_id: null,
                export_store_id: null,
                export_last_seq: null,
                held_by_move: null,
                not_before: null,
                backup_left: false,
                attention: false,
                failures: 0,
                failed_at: null,
            },
        ]);
        const objects = await pg.query(
            `select backup_store_id, copy_failures, replicated_at is not null as replicated from drive_objects`,
        );
        // The mark that release made stays as it made it; the worker names the replica at its start.
        expect(objects.rows).toEqual([
            { backup_store_id: null, copy_failures: 0, replicated: true },
        ]);
    });

    test('the key is the object and the store: one row per copy, never two for the same copy', async () => {
        const key = await pg.query(
            `select array_agg(a.attname::text order by k.ordinality) as columns
             from pg_index i
             cross join lateral unnest(i.indkey) with ordinality as k(attnum, ordinality)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where i.indrelid = 'drive_object_deletions'::regclass and i.indisprimary`,
        );
        expect(key.rows).toEqual([{ columns: ['object_id', 'store_id'] }]);
        const second = await pg.query<{ id: string }>(
            `insert into object_stores (source, kind, endpoint, signing_region, bucket, path_style, seal, secret_key_id, secret_sealed, status) values ('database', 'region', 'https://s3.example', 'auto', 'second', false, 'symmetric', $1, $2, 'ready') returning id`,
            [randomBytes(8), randomBytes(64)],
        );
        const objectId = randomUUID();
        const insert = (storeId: string) =>
            pg.query(
                `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published) values ($1, $2, 'ws/x/y', $3, true)`,
                [objectId, before.workspaceId, storeId],
            );
        expect(await sqlState(() => insert(PRIMARY))).toBeNull();
        // The same object's copy at another store: what the old key silently dropped.
        expect(await sqlState(() => insert(second.rows[0]!.id))).toBeNull();
        expect(await sqlState(() => insert(PRIMARY))).toBe('23505');
        await pg.query(`delete from drive_object_deletions where object_id = $1`, [objectId]);
    });

    test('no table was rewritten, and no new constraint was checked against a row under the migration’s locks', async () => {
        expect(await relfilenodes()).toBe(before.relfilenodes);
        expect(await validity(NEW_CONSTRAINTS)).toEqual(
            Object.fromEntries(NEW_CONSTRAINTS.map((name) => [name, false])),
        );
        // Unvalidated, they bind every row written from here on all the same.
        expect(
            await sqlState(() =>
                pg.query(`update drive_object_deletions set reason = 'gone' where done_at is null`),
            ),
        ).toBe('23514');
        expect(
            await sqlState(() =>
                pg.query(`update drive_objects set backup_store_id = $1`, [randomUUID()]),
            ),
        ).toBe('23503');
        // A move's hold is only ever on a copy a move left.
        expect(
            await sqlState(() =>
                pg.query(
                    `update drive_object_deletions set held_by_move = $1 where done_at is null`,
                    [randomUUID()],
                ),
            ),
        ).toBe('23514');
    });

    test('the orphan sweep’s cursor is now the environment primary’s own, where it had got to', async () => {
        const rows = await pg.query(`select name, cursor from drive_sweeps`);
        expect(rows.rows).toEqual([{ name: `orphans/${PRIMARY}`, cursor: 'ws/abc/def' }]);
    });
});

describe('a container older than the stores release', () => {
    test('can no longer write a row that names no store: the insert fails and nothing is written', async () => {
        const workspaceId = before.workspaceId;
        const objectId = randomUUID();
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into drive_objects (id, workspace_id, object_key, content_suite, chunk_size, chunk_count, content_nonce, ciphertext_size, status) values ($1, $2, $3, 3, 8388608, 1, $4, 4096, 'pending')`,
                    [objectId, workspaceId, `ws/${workspaceId}/${objectId}`, randomBytes(16)],
                ),
            ),
        ).toBe('23502');
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into drive_object_deletions (object_id, workspace_id, object_key, published) values ($1, $2, 'ws/x/z', true)`,
                    [objectId, workspaceId],
                ),
            ),
        ).toBe('23502');
        const existing = await pg.query<{ node_id: string; version_id: string; object_id: string }>(
            `select node_id, version_id, object_id from drive_uploads where id = $1`,
            [before.uploadId],
        );
        const upload = existing.rows[0]!;
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into drive_uploads (workspace_id, node_id, version_id, object_id, object_key, key_epoch, new_node, multipart_id, reserved_bytes, expires_at) values ($1, $2, $3, $4, 'ws/x/z', 1, true, 'mp', 4096, now() + interval '1 day')`,
                    [workspaceId, upload.node_id, upload.version_id, upload.object_id],
                ),
            ),
        ).toBe('23502');
        expect(
            (await pg.query(`select 1 from drive_objects where id = $1`, [objectId])).rows,
        ).toEqual([]);
    });
});

describe('a container of the stores release, still running beside the new ones', () => {
    test('its uploads, its retires and its outbox marks all still work, and its rows read as purges', async () => {
        const written = await writeAsStoresRelease();
        await pg.query(`update drive_uploads set multipart_id = 'mp-late' where id = $1`, [
            written.uploadId,
        ]);
        await pg.query(
            `update file_versions set status = 'purged', content_key_envelope = null, purged_at = now() where id = $1`,
            [written.versionId],
        );
        await pg.query(
            `update drive_uploads set status = 'aborted', reserved_bytes = 0 where id = $1`,
            [written.uploadId],
        );
        await retireAsStoresRelease(written.objectId);
        // Its replication mark and its deletion marks find a row by the object alone.
        await pg.query(`update drive_object_deletions set replicated = true where object_id = $1`, [
            written.objectId,
        ]);
        await pg.query(
            `update drive_object_deletions set primary_deleted_at = now(), delete_replica_after = now() + interval '30 days', done_at = null where object_id = $1`,
            [written.objectId],
        );
        const queued = await pg.query(
            `select store_id, reason, published, replicated, backup_store_id, backup_left, attention, failures, primary_deleted_at is not null as primary_deleted from drive_object_deletions where object_id = $1`,
            [written.objectId],
        );
        expect(queued.rows).toEqual([
            {
                store_id: PRIMARY,
                reason: 'purged',
                published: true,
                replicated: true,
                // Not named by that release: read as the environment's replica by this one.
                backup_store_id: null,
                backup_left: false,
                attention: false,
                failures: 0,
                primary_deleted: true,
            },
        ]);
        // Queued twice (a retry of the same retire), it is still one row.
        await pg.query(
            `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published, replicated) values ($1, $2, 'ws/x/y', $3, true, false) on conflict do nothing`,
            [written.objectId, written.workspaceId, PRIMARY],
        );
        expect(
            (
                await pg.query(`select 1 from drive_object_deletions where object_id = $1`, [
                    written.objectId,
                ])
            ).rows,
        ).toHaveLength(1);
    });
});

describe('the step after the migration', () => {
    test('VALIDATE CONSTRAINT takes a lock that blocks no read and no write, on the table and on the one it points at', async () => {
        await pg.query('begin');
        await pg.query(
            `alter table drive_objects validate constraint drive_objects_backup_store_id_object_stores_id_fkey`,
        );
        const locks = await pg.query<{ relation: string; mode: string }>(
            `select c.relname as relation, l.mode from pg_locks l join pg_class c on c.oid = l.relation
             where l.pid = pg_backend_pid() and l.locktype = 'relation' and c.relname in ('drive_objects', 'object_stores')
             order by c.relname, l.mode`,
        );
        // Rolled back: the step itself must still find it unvalidated below.
        await pg.query('rollback');
        const strongest = (relation: string) =>
            locks.rows.filter((row) => row.relation === relation).map((row) => row.mode);
        // SHARE UPDATE EXCLUSIVE conflicts with schema changes and VACUUM only; ROW SHARE with
        // nothing short of an exclusive lock. No reader or writer waits for either.
        const harmless = ['AccessShareLock', 'RowShareLock', 'ShareUpdateExclusiveLock'];
        expect(strongest('drive_objects')).toContain('ShareUpdateExclusiveLock');
        for (const relation of ['drive_objects', 'object_stores'])
            for (const mode of strongest(relation)) expect(harmless, relation).toContain(mode);
    });

    test('validates every constraint left unvalidated and builds the index, and does nothing the second time', async () => {
        const all = AFTER_MIGRATE.map((step) => step.name);
        expect((await pendingAfterMigrate(query)).map((step) => step.name)).toEqual(all);
        const first = await runAfterMigrate(query);
        expect(first).toEqual({ done: all, failed: [] });
        const constraints = AFTER_MIGRATE.filter((step) => step.kind === 'validate').map(
            (step) => step.name,
        );
        expect(Object.values(await validity(constraints))).toEqual(constraints.map(() => true));
        const unvalidated = await pg.query(
            `select c.conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where not c.convalidated and n.nspname = 'public'`,
        );
        expect(unvalidated.rows).toEqual([]);
        const index = await pg.query(
            `select i.indisvalid, i.indisready from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'drive_objects_store_idx'`,
        );
        expect(index.rows).toEqual([{ indisvalid: true, indisready: true }]);
        expect(await pendingAfterMigrate(query)).toEqual([]);
        expect(await runAfterMigrate(query)).toEqual({ done: [], failed: [] });
        // Still not rewritten: validating and indexing read the tables, nothing more.
        expect(await relfilenodes()).toBe(before.relfilenodes);
    });

    test('a constraint an old row breaks is reported by name and code, stays pending, and stops nothing else', async () => {
        // An outbox row from before the check, with a reason the check refuses.
        await pg.query(
            `alter table drive_object_deletions drop constraint drive_object_deletions_reason_valid`,
        );
        const objectId = randomUUID();
        await pg.query(
            `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, reason, published) values ($1, $2, 'ws/secret-looking/key', $3, 'lost', true)`,
            [objectId, before.workspaceId, PRIMARY],
        );
        await pg.query(
            `alter table drive_object_deletions add constraint drive_object_deletions_reason_valid check (reason in ('purged', 'moved', 'stray')) not valid`,
        );
        // And an index a build left behind half made.
        await pg.query(
            `update pg_index set indisvalid = false where indexrelid = 'drive_objects_store_idx'::regclass`,
        );
        expect((await pendingAfterMigrate(query)).map((step) => step.name)).toEqual([
            'drive_object_deletions_reason_valid',
            'drive_objects_store_idx',
        ]);
        const result = await runAfterMigrate(query);
        expect(result).toEqual({
            done: ['drive_objects_store_idx'],
            failed: [
                { name: 'drive_object_deletions_reason_valid', kind: 'validate', code: '23514' },
            ],
        });
        // What is reported names the constraint and the SQLSTATE, and nothing a row holds.
        expect(JSON.stringify(result)).not.toContain('secret-looking');
        const index = await pg.query(
            `select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'drive_objects_store_idx'`,
        );
        expect(index.rows).toEqual([{ indisvalid: true }]);
        expect((await pendingAfterMigrate(query)).map((step) => step.name)).toEqual([
            'drive_object_deletions_reason_valid',
        ]);
        // The row put right, the next run finishes the job.
        await pg.query(`delete from drive_object_deletions where object_id = $1`, [objectId]);
        expect(await runAfterMigrate(query)).toEqual({
            done: ['drive_object_deletions_reason_valid'],
            failed: [],
        });
    });
});
