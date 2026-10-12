import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import * as admin from './admin';
import { getStorageAllowance } from './auth';
import { db } from './client';
import { driveObjects, storageEntitlements, users, workspaceStorage } from './schema';

/*
 * What an operator lists has to agree with what each person is told: an
 * account's allowance in the list is the allowance the account itself sees,
 * grants that are revoked, expired or not started yet count for neither, a
 * search finds the text typed and nothing else, and filters and sorting hold.
 */

const GIB = 1_073_741_824n;
const DAY = 24 * 3600 * 1000;

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function grant(
    workspaceId: string,
    quotaBytes: bigint,
    window: { startsAt?: Date; expiresAt?: Date | null; revokedAt?: Date | null } = {},
) {
    await db.insert(storageEntitlements).values({
        workspaceId,
        source: 'test',
        sourceReference: randomUUID(),
        quotaBytes,
        startsAt: window.startsAt ?? new Date(Date.now() - DAY),
        expiresAt: window.expiresAt ?? null,
        revokedAt: window.revokedAt ?? null,
    });
}

describe('operator lists', () => {
    test('an account’s allowance in the list is the one it sees, counting only grants in force', async () => {
        const account = await createTestAccount({ quotaBytes: 2n * GIB });
        await grant(account.workspaceId, 200n * GIB);
        await grant(account.workspaceId, 1n * GIB, { revokedAt: new Date() });
        await grant(account.workspaceId, 5n * GIB, { expiresAt: new Date(Date.now() - 1000) });
        await grant(account.workspaceId, 7n * GIB, { startsAt: new Date(Date.now() + DAY) });

        const own = await getStorageAllowance(account.userId);
        const { accounts } = await admin.listAccounts({});
        const listed = accounts.find((row) => row.id === account.userId);
        expect(listed?.quotaBytes).toBe((202n * GIB).toString());
        expect(listed?.quotaBytes).toBe(own?.quotaBytes);

        const { workspaces } = await admin.listWorkspaces({});
        expect(workspaces.find((row) => row.id === account.workspaceId)?.quotaBytes).toBe(
            own?.quotaBytes,
        );
        expect((await admin.getAccount(account.userId))?.quotaBytes).toBe(own?.quotaBytes);
    });

    test('a search matches the text typed, with % and _ taken literally', async () => {
        await createTestAccount({ email: 'a_b@hushos.test' });
        await createTestAccount({ email: 'axb@hushos.test' });
        await createTestAccount({ email: '100%sure@hushos.test' });
        await createTestAccount({ email: '1000sure@hushos.test' });

        const underscore = await admin.listAccounts({ query: 'a_b' });
        expect(underscore.accounts.map((row) => row.email)).toEqual(['a_b@hushos.test']);
        expect(underscore.total).toBe(1);
        const percent = await admin.listAccounts({ query: '100%' });
        expect(percent.accounts.map((row) => row.email)).toEqual(['100%sure@hushos.test']);
        // Case doesn't matter, and the name is searched as well as the email.
        expect((await admin.listAccounts({ query: 'AXB' })).total).toBe(1);
        expect((await admin.listAccounts({ query: 'Test' })).total).toBe(4);
    });

    test('the role filter returns operators only, and the count says how many', async () => {
        const operator = await createTestAccount();
        await createTestAccount();
        await createTestAccount();
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, operator.userId));

        const admins = await admin.listAccounts({ role: 'admin' });
        expect(admins.total).toBe(1);
        expect(admins.accounts.map((row) => row.id)).toEqual([operator.userId]);
        expect((await admin.listAccounts({ role: 'member' })).total).toBe(2);
    });

    test('sorting by storage puts the fullest first, in both lists', async () => {
        const small = await createTestAccount();
        const large = await createTestAccount();
        await db
            .update(workspaceStorage)
            .set({ usedBytes: 900n })
            .where(eq(workspaceStorage.workspaceId, large.workspaceId));
        await db
            .update(workspaceStorage)
            .set({ usedBytes: 10n })
            .where(eq(workspaceStorage.workspaceId, small.workspaceId));

        const accounts = await admin.listAccounts({ sort: 'stored' });
        expect(accounts.accounts.map((row) => row.id)).toEqual([large.userId, small.userId]);
        expect(accounts.accounts[0]?.usedBytes).toBe('900');
        const workspaces = await admin.listWorkspaces({ sort: 'stored' });
        expect(workspaces.workspaces.map((row) => row.ownerEmail)).toEqual([
            large.email,
            small.email,
        ]);
    });

    test('a workspace counts its own missing objects, and an unknown account is nothing', async () => {
        const account = await createTestAccount();
        const other = await createTestAccount();
        for (const status of ['missing', 'missing', 'ready'] as const) {
            const id = randomUUID();
            // A one-chunk suite 2 object: the framing check wants 16 bytes of tag per chunk.
            await db.insert(driveObjects).values({
                id,
                workspaceId: account.workspaceId,
                objectKey: `ws/${account.workspaceId}/${id}`,
                contentSuite: 2,
                chunkSize: 8 * 1024 * 1024,
                chunkCount: 1,
                contentNonce: Buffer.alloc(16),
                ciphertextSize: 116n,
                status,
            });
        }
        const { workspaces } = await admin.listWorkspaces({});
        expect(workspaces.find((row) => row.id === account.workspaceId)?.missing).toBe(2);
        expect(workspaces.find((row) => row.id === other.workspaceId)?.missing).toBe(0);
        const detail = await admin.getAccount(account.userId);
        expect(detail?.objects).toEqual({ ready: 1, missing: 2 });
        expect(await admin.getAccount(randomUUID())).toBeNull();
    });
});

describe('storage an operator adds', () => {
    async function allowance(userId: string) {
        return BigInt((await getStorageAllowance(userId))!.quotaBytes);
    }

    test('a grant raises that account’s allowance at once, and no one else’s', async () => {
        const operator = await createTestAccount();
        const account = await createTestAccount({ quotaBytes: 2n * GIB });
        const other = await createTestAccount({ quotaBytes: 2n * GIB });

        const granted = await admin.grantAdminStorage({
            workspaceId: account.workspaceId,
            quotaBytes: 100n * GIB,
            expiresAt: null,
            actorUserId: operator.userId,
            note: '  Support case 41  ',
        });
        if (granted.status !== 'ok') throw new Error(granted.status);
        expect(granted.quotaBytes).toBe((102n * GIB).toString());
        expect(await allowance(account.userId)).toBe(102n * GIB);
        expect(await allowance(other.userId)).toBe(2n * GIB);
        expect((await admin.getAccount(account.userId))?.quotaBytes).toBe(granted.quotaBytes);

        const [row] = await db
            .select()
            .from(storageEntitlements)
            .where(eq(storageEntitlements.id, granted.entitlementId));
        expect(row).toMatchObject({ source: 'admin', grantedBy: operator.userId });
        expect(row?.note).toBe('Support case 41');
        expect(row?.sourceReference).toMatch(/^admin:[0-9a-f-]{36}$/);
        const listed = (await admin.getAccount(account.userId))?.grants[0];
        expect(listed).toMatchObject({
            id: granted.entitlementId,
            source: 'admin',
            grantedByEmail: operator.email,
        });

        // A second grant is its own row, never a collision with the first.
        const again = await admin.grantAdminStorage({
            workspaceId: account.workspaceId,
            quotaBytes: 1n * GIB,
            expiresAt: null,
            actorUserId: operator.userId,
        });
        expect(again).toMatchObject({ status: 'ok', quotaBytes: (103n * GIB).toString() });
    });

    test('an end date stops it counting, and so does revoking it', async () => {
        const operator = await createTestAccount();
        const account = await createTestAccount({ quotaBytes: 2n * GIB });
        const until = await admin.grantAdminStorage({
            workspaceId: account.workspaceId,
            quotaBytes: 10n * GIB,
            expiresAt: new Date(Date.now() + DAY),
            actorUserId: operator.userId,
        });
        const forever = await admin.grantAdminStorage({
            workspaceId: account.workspaceId,
            quotaBytes: 5n * GIB,
            expiresAt: null,
            actorUserId: operator.userId,
        });
        if (until.status !== 'ok' || forever.status !== 'ok') throw new Error('not granted');
        expect(await allowance(account.userId)).toBe(17n * GIB);

        // The day passes.
        await db
            .update(storageEntitlements)
            .set({
                startsAt: new Date(Date.now() - 2 * DAY),
                expiresAt: new Date(Date.now() - 1000),
            })
            .where(eq(storageEntitlements.id, until.entitlementId));
        expect(await allowance(account.userId)).toBe(7n * GIB);

        const revoked = await admin.revokeAdminStorage(forever.entitlementId, account.workspaceId);
        expect(revoked).toEqual({ status: 'ok', quotaBytes: (2n * GIB).toString() });
        expect(await allowance(account.userId)).toBe(2n * GIB);
        const [first] = await db
            .select({ revokedAt: storageEntitlements.revokedAt })
            .from(storageEntitlements)
            .where(eq(storageEntitlements.id, forever.entitlementId));
        // Revoking again changes nothing, not even when it was revoked.
        expect(
            (await admin.revokeAdminStorage(forever.entitlementId, account.workspaceId)).status,
        ).toBe('ok');
        const [second] = await db
            .select({ revokedAt: storageEntitlements.revokedAt })
            .from(storageEntitlements)
            .where(eq(storageEntitlements.id, forever.entitlementId));
        expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
    });

    test('revoking refuses a plan’s or a referral’s grant, and another account’s', async () => {
        const operator = await createTestAccount();
        const account = await createTestAccount({ quotaBytes: 2n * GIB });
        const other = await createTestAccount({ quotaBytes: 2n * GIB });
        const [plan] = await db
            .insert(storageEntitlements)
            .values({
                workspaceId: account.workspaceId,
                source: 'polar',
                sourceReference: `sub_${randomUUID()}`,
                quotaBytes: 200n * GIB,
            })
            .returning({ id: storageEntitlements.id });
        const [referral] = await db
            .insert(storageEntitlements)
            .values({
                workspaceId: account.workspaceId,
                source: 'referral',
                sourceReference: `referral:${randomUUID()}:inviter`,
                quotaBytes: 1n * GIB,
            })
            .returning({ id: storageEntitlements.id });
        const theirs = await admin.grantAdminStorage({
            workspaceId: other.workspaceId,
            quotaBytes: 50n * GIB,
            expiresAt: null,
            actorUserId: operator.userId,
        });
        if (theirs.status !== 'ok') throw new Error(theirs.status);

        for (const id of [plan!.id, referral!.id, theirs.entitlementId, randomUUID()])
            expect(await admin.revokeAdminStorage(id, account.workspaceId)).toEqual({
                status: 'not-found',
            });
        expect(await allowance(account.userId)).toBe(203n * GIB);
        expect(await allowance(other.userId)).toBe(52n * GIB);
        expect(
            (await db.select().from(storageEntitlements)).every((row) => row.revokedAt === null),
        ).toBe(true);
    });

    test('an amount of nothing, less, or past 100 TiB is refused, as is an end date already past', async () => {
        const operator = await createTestAccount();
        const account = await createTestAccount({ quotaBytes: 2n * GIB });
        const grant = (quotaBytes: bigint, expiresAt: Date | null = null, note?: string) =>
            admin.grantAdminStorage({
                workspaceId: account.workspaceId,
                quotaBytes,
                expiresAt,
                actorUserId: operator.userId,
                note,
            });
        for (const amount of [0n, -1n * GIB, admin.ADMIN_STORAGE_MAX_BYTES + 1n])
            expect(await grant(amount)).toEqual({ status: 'invalid-amount' });
        expect(await grant(GIB, new Date(Date.now() - 1000))).toEqual({
            status: 'invalid-expiry',
        });
        expect(await grant(GIB, new Date())).toEqual({ status: 'invalid-expiry' });
        expect(await grant(GIB, null, 'x'.repeat(501))).toEqual({ status: 'invalid-note' });
        expect(
            await admin.grantAdminStorage({
                workspaceId: randomUUID(),
                quotaBytes: GIB,
                expiresAt: null,
                actorUserId: operator.userId,
            }),
        ).toEqual({ status: 'not-found' });
        expect(await db.select().from(storageEntitlements)).toEqual([]);
        expect(await allowance(account.userId)).toBe(2n * GIB);

        // The largest grant allowed is allowed.
        expect((await grant(admin.ADMIN_STORAGE_MAX_BYTES)).status).toBe('ok');
        expect(await allowance(account.userId)).toBe(2n * GIB + admin.ADMIN_STORAGE_MAX_BYTES);
    });
});
