import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDatabase, resetDatabase } from '../test/helpers';
import { consumeRateLimit } from './auth';
import { db } from './client';
import { keyedHash } from './hash-key';
import { authRateLimits, serverSecrets } from './schema';

/*
 * Addresses, emails and account ids are hashed under a key the database never
 * holds, so a dump cannot be matched against a list of them. The key has to be
 * stable where it can be (every process and restart of one instance agree) and
 * the hashes have to keep working as rate-limit buckets.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const SETUP = 'A'.repeat(60) + 'B'.repeat(60);
const OTHER_SETUP = 'C'.repeat(120);

beforeEach(resetDatabase);
afterAll(closeDatabase);

/* The key a freshly started process would use, with the environment as given. */
async function keyOfProcess(setup: string | undefined) {
    vi.resetModules();
    if (setup === undefined) delete process.env.OPAQUE_SERVER_SETUP;
    else process.env.OPAQUE_SERVER_SETUP = setup;
    const module = await import('./hash-key');
    return module.serverHashKey();
}

describe('the server hash key', () => {
    const original = process.env.OPAQUE_SERVER_SETUP;
    afterEach(() => {
        if (original === undefined) delete process.env.OPAQUE_SERVER_SETUP;
        else process.env.OPAQUE_SERVER_SETUP = original;
        vi.resetModules();
    });

    test('the same input hashes the same within a process, and never as its plain SHA-256', () => {
        expect(keyedHash('1.2.3.4').equals(keyedHash('1.2.3.4'))).toBe(true);
        expect(keyedHash('1.2.3.4').equals(keyedHash('1.2.3.5'))).toBe(false);
        expect(keyedHash('1.2.3.4').equals(sha256('1.2.3.4'))).toBe(false);
        expect(keyedHash('1.2.3.4')).toHaveLength(32);
    });

    test('derived from the OPAQUE setup, every process of an instance agrees; another setup differs', async () => {
        const first = await keyOfProcess(SETUP);
        const restarted = await keyOfProcess(SETUP);
        expect(first.equals(restarted)).toBe(true);
        expect(first.equals(await keyOfProcess(OTHER_SETUP))).toBe(false);
        // Not the setup itself, which would put the password setup's bytes into every hash.
        expect(first.equals(Buffer.from(SETUP, 'base64url').subarray(0, 32))).toBe(false);
    });

    test('without the OPAQUE setup, each process makes its own key', async () => {
        const first = await keyOfProcess(undefined);
        const second = await keyOfProcess(undefined);
        expect(first).toHaveLength(32);
        expect(first.equals(second)).toBe(false);
    });
});

describe('what the database keeps', () => {
    test('a rate-limit bucket is stored keyed, and still counts as one bucket', async () => {
        const bucket = sha256('auth:address:203.0.113.7');
        expect(await consumeRateLimit(bucket, 2, 60_000)).toBe(true);
        expect(await consumeRateLimit(bucket, 2, 60_000)).toBe(true);
        expect(await consumeRateLimit(bucket, 2, 60_000)).toBe(false);
        // Another address has its own budget.
        expect(await consumeRateLimit(sha256('auth:address:203.0.113.8'), 2, 60_000)).toBe(true);

        const rows = await db.select().from(authRateLimits);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.keyHash.equals(bucket)).toBe(false);
            expect(row.keyHash.equals(sha256('auth:address:203.0.113.7'))).toBe(false);
        }
        expect(rows.some((row) => row.keyHash.equals(keyedHash(bucket)))).toBe(true);
    });

    test('hashing and counting leave no key behind in the database', async () => {
        keyedHash('report:reporter:203.0.113.7');
        await consumeRateLimit(sha256('report:address:203.0.113.7'), 20, 3600_000);
        // A key beside the hashes it made is what a dump would need to undo them.
        expect(await db.select().from(serverSecrets)).toEqual([]);
    });
});
