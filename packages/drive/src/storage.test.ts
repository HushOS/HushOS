import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Which store a row's id opens, per process (docs/company-storage-design.md
 * 2.1). The environment's stores are rows that hold nothing: each process
 * fills them in from its own variables, so what a row opens is decided by the
 * environment the process started with and by nothing in the database. No
 * request is made here; a store is only built.
 */

const PRIMARY_ID = '00000000-0000-4000-8000-000000000001';
const REPLICA_ID = '00000000-0000-4000-8000-000000000002';

const REPLICA = {
    STORAGE_REPLICA_ENDPOINT: 'https://replica.store.test',
    STORAGE_REPLICA_BUCKET: 'hushos-replica',
    STORAGE_REPLICA_ACCESS_KEY_ID: 'replica-key',
    STORAGE_REPLICA_SECRET_ACCESS_KEY: 'replica-secret',
};

/* The module as a process started with `env` loads it. */
async function startedWith(env: Record<string, string>) {
    for (const name of Object.keys(process.env))
        if (name.startsWith('STORAGE_REPLICA_')) delete process.env[name];
    Object.assign(process.env, { STORAGE_BUCKET: 'hushos-primary' }, env);
    vi.resetModules();
    return import('./storage');
}

beforeEach(() => {
    // The one line a store that cannot be opened logs; not what these tests are about.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('storeFor', () => {
    test('the web service, which holds no replica variables, opens the primary’s row and cannot open the replica’s', async () => {
        const { storeFor, StoreUnavailableError } = await startedWith({});
        const primary = await storeFor(PRIMARY_ID);
        expect(primary.bucket).toBe('hushos-primary');
        // One client per process, not one per request.
        expect(await storeFor(PRIMARY_ID)).toBe(primary);
        const refused = await storeFor(REPLICA_ID).then(
            () => null,
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(StoreUnavailableError);
        expect(refused).toMatchObject({ storeId: REPLICA_ID });
    });

    test('the worker, which holds them, opens each row as its own bucket', async () => {
        const { storeFor, replicaStore } = await startedWith(REPLICA);
        expect((await storeFor(PRIMARY_ID)).bucket).toBe('hushos-primary');
        const replica = await storeFor(REPLICA_ID);
        expect(replica.bucket).toBe('hushos-replica');
        expect(replicaStore()).toBe(replica);
    });

    test('an id that is not the environment’s is never answered with the environment’s store', async () => {
        const { storeFor, StoreUnavailableError } = await startedWith(REPLICA);
        const id = randomUUID();
        const refused = await storeFor(id).then(
            () => null,
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(StoreUnavailableError);
        expect(refused).toMatchObject({ storeId: id });
        // What the caller may log or show: the id, and no address, bucket or key.
        expect(JSON.stringify(refused) + String(refused)).not.toMatch(
            /store\.test|hushos-primary|hushos-replica|replica-key|replica-secret/,
        );
    });

    test('an operator who changes STORAGE_BUCKET and restarts gets the new bucket under the same row', async () => {
        const before = await startedWith({ STORAGE_BUCKET: 'bucket-one' });
        expect((await before.storeFor(PRIMARY_ID)).bucket).toBe('bucket-one');
        // The row holds no copy of the settings, so there is nothing in the database to change.
        const after = await startedWith({ STORAGE_BUCKET: 'bucket-two' });
        expect((await after.storeFor(PRIMARY_ID)).bucket).toBe('bucket-two');
    });

    test('a replica described by halves is refused, not treated as absent', async () => {
        const { storeFor } = await startedWith({
            STORAGE_REPLICA_ENDPOINT: REPLICA.STORAGE_REPLICA_ENDPOINT,
            STORAGE_REPLICA_BUCKET: REPLICA.STORAGE_REPLICA_BUCKET,
        });
        await expect(storeFor(REPLICA_ID)).rejects.toThrow(/or none of them/);
    });
});
