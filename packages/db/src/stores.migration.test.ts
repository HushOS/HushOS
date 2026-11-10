import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/*
 * The storage-stores migration, run as a deployment runs it: against a
 * database migrated to the release before, holding rows that release wrote. A
 * scratch database of its own, so the shared test database's schema is never
 * taken apart. What must hold (docs/company-storage-design.md 2.1, 11.1):
 * every object, upload and outbox row ends up at the environment's primary
 * store; a container of the previous release, which names no store, still
 * writes there; no row can name no store or an unknown one; and the big tables
 * are neither rewritten nor scanned.
 */

const MIGRATION = '20261110000425_storage_stores';
const PRIMARY = '00000000-0000-4000-8000-000000000001';
const REPLICA = '00000000-0000-4000-8000-000000000002';

const testUrl = new URL(process.env.DATABASE_URL!);
const scratchName = `${testUrl.pathname.slice(1)}_stores_migration`;
if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error('Unexpected test database name.');
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratchName}`;

let admin: Client;
let pg: Client;

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

const before = { workspaceId: '', objectId: '', uploadId: '', retiredId: '', relfilenodes: '' };

/*
 * What the release before this one wrote, in its own words: no column of this
 * migration is named, and an upload always carries its multipart id.
 */
async function writeAsPreviousRelease() {
    const workspace = await pg.query<{ id: string }>(
        `insert into workspaces (owner_kind) values ('personal') returning id`,
    );
    const workspaceId = workspace.rows[0]!.id;
    const rootId = randomUUID();
    const nodeId = randomUUID();
    const objectId = randomUUID();
    const versionId = randomUUID();
    const retiredId = randomUUID();
    const node = `insert into drive_nodes (id, workspace_id, parent_id, kind, key_epoch, parent_key_epoch, key_envelope, metadata_envelope) values ($1, $2, $3, $4, 1, 1, $5, $6)`;
    await pg.query(node, [rootId, workspaceId, null, 'folder', randomBytes(72), randomBytes(296)]);
    await pg.query(node, [nodeId, workspaceId, rootId, 'file', randomBytes(72), randomBytes(296)]);
    await pg.query(
        `insert into drive_objects (id, workspace_id, object_key, content_suite, chunk_size, chunk_count, content_nonce, ciphertext_size, status) values ($1, $2, $3, 3, 8388608, 1, $4, 4096, 'pending')`,
        [objectId, workspaceId, `ws/${workspaceId}/${objectId}`, randomBytes(16)],
    );
    await pg.query(
        `insert into file_versions (id, node_id, workspace_id, object_id, content_key_envelope, status) values ($1, $2, $3, $4, $5, 'pending')`,
        [versionId, nodeId, workspaceId, objectId, randomBytes(84)],
    );
    const upload = await pg.query<{ id: string }>(
        `insert into drive_uploads (workspace_id, node_id, version_id, object_id, object_key, key_epoch, new_node, multipart_id, reserved_bytes, expires_at) values ($1, $2, $3, $4, $5, 1, true, $6, 4096, now() + interval '1 day') returning id`,
        [
            workspaceId,
            nodeId,
            versionId,
            objectId,
            `ws/${workspaceId}/${objectId}`,
            `mp-${objectId}`,
        ],
    );
    await pg.query(
        `insert into drive_object_deletions (object_id, workspace_id, object_key, published) values ($1, $2, $3, true)`,
        [retiredId, workspaceId, `ws/${workspaceId}/${retiredId}`],
    );
    return { workspaceId, nodeId, objectId, versionId, uploadId: upload.rows[0]!.id, retiredId };
}

async function relfilenodes() {
    const rows = await pg.query<{ relname: string; relfilenode: string }>(
        `select relname, relfilenode::text from pg_class where relname in ('drive_objects', 'drive_uploads', 'drive_object_deletions') order by relname`,
    );
    return rows.rows.map((row) => `${row.relname}:${row.relfilenode}`).join(',');
}

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
    const written = await writeAsPreviousRelease();
    Object.assign(before, written, { relfilenodes: await relfilenodes() });
    await migrate(MIGRATION);
}, 120_000);

// Dropping a database checkpoints first, which takes seconds on a busy machine.
afterAll(async () => {
    await pg?.end();
    await admin?.query(`drop database if exists "${scratchName}" with (force)`);
    await admin?.end();
}, 120_000);

describe('what the migration leaves', () => {
    test('every object, upload and outbox row from before is at the environment’s primary store', async () => {
        for (const table of ['drive_objects', 'drive_uploads', 'drive_object_deletions']) {
            const rows = await pg.query<{ store_id: string; rows: string }>(
                `select store_id, count(*)::text as rows from ${table} group by store_id`,
            );
            expect(rows.rows, table).toEqual([{ store_id: PRIMARY, rows: '1' }]);
        }
        // The upload the previous release began is untouched besides: still open, with its id.
        const upload = await pg.query<{ multipart_id: string; status: string }>(
            `select multipart_id, status from drive_uploads where id = $1`,
            [before.uploadId],
        );
        expect(upload.rows[0]).toEqual({ multipart_id: `mp-${before.objectId}`, status: 'open' });
    });

    test('the environment’s stores are two rows with fixed ids that hold no address, bucket or key', async () => {
        const rows = await pg.query(`select * from object_stores order by id`);
        expect(
            rows.rows.map((row) => ({
                id: row.id,
                source: row.source,
                kind: row.kind,
                status: row.status,
                env_present: row.env_present,
            })),
        ).toEqual([
            {
                id: PRIMARY,
                source: 'environment',
                kind: 'region',
                status: 'ready',
                env_present: true,
            },
            // The replica is described by the worker's environment or not at all: absent
            // until a worker says otherwise.
            {
                id: REPLICA,
                source: 'environment',
                kind: 'backup',
                status: 'ready',
                env_present: false,
            },
        ]);
        for (const row of rows.rows)
            for (const column of [
                'group_id',
                'endpoint',
                'internal_endpoint',
                'signing_region',
                'bucket',
                'path_style',
                'origin',
                'key_hint',
                'seal',
                'secret_key_id',
                'secret_nonce',
                'secret_sealed',
            ])
                expect(row[column], `${row.id}.${column}`).toBeNull();
    });

    test('one region, the default, points at the primary with the replica as its backup', async () => {
        const rows = await pg.query(
            `select code, label, store_id, backup_store_id, backup_every, backup_prune, is_default, offered from storage_regions`,
        );
        expect(rows.rows).toEqual([
            {
                code: 'default',
                label: 'Default',
                store_id: PRIMARY,
                backup_store_id: REPLICA,
                backup_every: '5m',
                // As the replica behaves today: its copy of a purged object goes 30 days on.
                backup_prune: true,
                is_default: true,
                offered: true,
            },
        ]);
    });

    test('the three tables were not rewritten, and their new constraints were not checked against old rows', async () => {
        // A rewrite gives a table a new file; a constant default is a catalog change.
        expect(await relfilenodes()).toBe(before.relfilenodes);
        const constraints = await pg.query<{ conname: string; convalidated: boolean }>(
            `select conname, convalidated from pg_constraint where conname in ('drive_objects_store_id_object_stores_id_fkey', 'drive_uploads_store_id_object_stores_id_fkey', 'drive_object_deletions_store_id_object_stores_id_fkey', 'drive_uploads_multipart_started') order by conname`,
        );
        expect(constraints.rows).toEqual([
            {
                conname: 'drive_object_deletions_store_id_object_stores_id_fkey',
                convalidated: false,
            },
            { conname: 'drive_objects_store_id_object_stores_id_fkey', convalidated: false },
            { conname: 'drive_uploads_multipart_started', convalidated: false },
            { conname: 'drive_uploads_store_id_object_stores_id_fkey', convalidated: false },
        ]);
    });
});

describe('a container of the previous release, still running beside the new ones', () => {
    test('its inserts, which name no store, land at the environment’s primary', async () => {
        const written = await writeAsPreviousRelease();
        const object = await pg.query(`select store_id from drive_objects where id = $1`, [
            written.objectId,
        ]);
        const upload = await pg.query(
            `select store_id, multipart_id from drive_uploads where id = $1`,
            [written.uploadId],
        );
        const retired = await pg.query(
            `select store_id from drive_object_deletions where object_id = $1`,
            [written.retiredId],
        );
        expect(object.rows).toEqual([{ store_id: PRIMARY }]);
        expect(upload.rows).toEqual([
            { store_id: PRIMARY, multipart_id: `mp-${written.objectId}` },
        ]);
        expect(retired.rows).toEqual([{ store_id: PRIMARY }]);
    });

    test('it can still complete and abort the uploads it began', async () => {
        const written = await writeAsPreviousRelease();
        await pg.query(
            `update drive_uploads set status = 'completing', completing_at = now() where id = $1`,
            [written.uploadId],
        );
        await pg.query(`update drive_uploads set status = 'completed' where id = $1`, [
            written.uploadId,
        ]);
        const row = await pg.query(`select status from drive_uploads where id = $1`, [
            written.uploadId,
        ]);
        expect(row.rows).toEqual([{ status: 'completed' }]);
    });
});

describe('what the schema now refuses', () => {
    test('a row with no store, on each of the three tables', async () => {
        const fresh = await writeAsPreviousRelease();
        expect(
            await sqlState(() =>
                pg.query(`update drive_objects set store_id = null where id = $1`, [
                    fresh.objectId,
                ]),
            ),
        ).toBe('23502');
        expect(
            await sqlState(() =>
                pg.query(`update drive_uploads set store_id = null where id = $1`, [
                    fresh.uploadId,
                ]),
            ),
        ).toBe('23502');
        expect(
            await sqlState(() =>
                pg.query(`update drive_object_deletions set store_id = null where object_id = $1`, [
                    fresh.retiredId,
                ]),
            ),
        ).toBe('23502');
    });

    test('a row naming a store that does not exist, old rows included', async () => {
        const unknown = randomUUID();
        // The row written before the migration: the unvalidated key still binds it.
        expect(
            await sqlState(() =>
                pg.query(`update drive_objects set store_id = $2 where id = $1`, [
                    before.objectId,
                    unknown,
                ]),
            ),
        ).toBe('23503');
        expect(
            await sqlState(() =>
                pg.query(`update drive_uploads set store_id = $2 where id = $1`, [
                    before.uploadId,
                    unknown,
                ]),
            ),
        ).toBe('23503');
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into drive_object_deletions (object_id, workspace_id, object_key, store_id, published) values ($1, $2, $3, $4, true)`,
                    [randomUUID(), before.workspaceId, 'ws/x/y', unknown],
                ),
            ),
        ).toBe('23503');
    });

    test('removing a store that rows still name', async () => {
        expect(
            await sqlState(() => pg.query(`delete from object_stores where id = $1`, [PRIMARY])),
        ).toBe('23503');
    });

    test('an environment row that holds an address, a third one, and a kind for anything else', async () => {
        // The environment's settings never move into the database.
        expect(
            await sqlState(() =>
                pg.query(`update object_stores set endpoint = 'https://s3.example' where id = $1`, [
                    PRIMARY,
                ]),
            ),
        ).toBe('23514');
        expect(
            await sqlState(() =>
                pg.query(`update object_stores set bucket = 'hushos' where id = $1`, [REPLICA]),
            ),
        ).toBe('23514');
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into object_stores (source, kind, status, env_present) values ('environment', 'backup', 'ready', true)`,
                ),
            ),
        ).toBe('23514');
        // The evidence bucket is not a store: there is no row and no kind for it (decision 15).
        expect(
            await sqlState(() =>
                pg.query(
                    `insert into object_stores (source, kind, status) values ('database', 'evidence', 'ready')`,
                ),
            ),
        ).toBe('23514');
        // The replica's row is a backup and cannot be made a store people upload to.
        expect(
            await sqlState(() =>
                pg.query(`update object_stores set kind = 'region' where id = $1`, [REPLICA]),
            ),
        ).toBe('23514');
    });

    test('a database store without its whole address, with the wrong seal for its kind, or with no company', async () => {
        const store = `insert into object_stores (source, kind, endpoint, signing_region, bucket, path_style, seal, secret_key_id, secret_sealed, status) values ('database', 'region', 'https://s3.example', 'auto', $1, false, 'symmetric', $2, $3, 'draft')`;
        const sealed = () => [randomBytes(8), randomBytes(64)];
        expect(await sqlState(() => pg.query(store, ['second', ...sealed()]))).toBeNull();
        // No bucket: there would be nothing to sign a URL for.
        expect(await sqlState(() => pg.query(store, [null, ...sealed()]))).toBe('23514');
        // A region's key is sealed symmetrically; a worker seal there would hide it from the web.
        expect(
            await sqlState(() =>
                pg.query(store.replace(`'symmetric'`, `'worker'`), ['third', ...sealed()]),
            ),
        ).toBe('23514');
        // A company's store belongs to a company.
        expect(
            await sqlState(() =>
                pg.query(store.replace(`'region'`, `'company'`), ['fourth', ...sealed()]),
            ),
        ).toBe('23514');
    });

    test('the environment’s store as a draft or retired, while a failed check may still mark it', async () => {
        const mark = (status: string) =>
            sqlState(() =>
                pg.query(`update object_stores set status = $2 where id = $1`, [PRIMARY, status]),
            );
        expect(await mark('draft')).toBe('23514');
        expect(await mark('retired')).toBe('23514');
        expect(await mark('failing')).toBeNull();
        expect(await mark('ready')).toBeNull();
    });

    test('a second default region, a region with no store, and a backup that is its own store', async () => {
        const region = `insert into storage_regions (code, label, store_id, backup_store_id, is_default) values ($1, 'Another', $2, $3, $4)`;
        expect(await sqlState(() => pg.query(region, ['eu', PRIMARY, null, true]))).toBe('23505');
        expect(await sqlState(() => pg.query(region, ['eu', null, null, false]))).toBe('23502');
        expect(await sqlState(() => pg.query(region, ['eu', PRIMARY, PRIMARY, false]))).toBe(
            '23514',
        );
        expect(await sqlState(() => pg.query(region, ['eu', randomUUID(), null, false]))).toBe(
            '23503',
        );
        expect(await sqlState(() => pg.query(region, ['eu', PRIMARY, null, false]))).toBeNull();
    });

    test('an upload without a multipart id anywhere past open', async () => {
        const fresh = await writeAsPreviousRelease();
        // Begin now commits the row first: open without an id is how every upload starts.
        expect(
            await sqlState(() =>
                pg.query(`update drive_uploads set multipart_id = null where id = $1`, [
                    fresh.uploadId,
                ]),
            ),
        ).toBeNull();
        expect(
            await sqlState(() =>
                pg.query(
                    `update drive_uploads set status = 'completing', completing_at = now() where id = $1`,
                    [fresh.uploadId],
                ),
            ),
        ).toBe('23514');
        expect(
            await sqlState(() =>
                pg.query(`update drive_uploads set status = 'aborted' where id = $1`, [
                    fresh.uploadId,
                ]),
            ),
        ).toBeNull();
    });
});
