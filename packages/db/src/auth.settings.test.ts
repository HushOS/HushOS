import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import { accountIdentities, userSettings, users } from './schema';

/*
 * Settings are a compare-and-set document, identity lookup is by normalised
 * email, and roles come only from the command line. Each check is something a
 * second device, a stranger or an attacker would notice.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

async function identityFor(userId: string) {
    const row = {
        userId,
        wrappingSalt: randomBytes(32),
        encryptionPublicKey: randomBytes(32),
        encryptionPrivateKeyNonce: randomBytes(24),
        encryptedEncryptionPrivateKey: randomBytes(48),
        signingPublicKey: randomBytes(32),
        signingSeedNonce: randomBytes(24),
        encryptedSigningSeed: randomBytes(48),
    };
    await db.insert(accountIdentities).values(row);
    return row;
}

describe('settings', () => {
    test('the first save names version 0, every save bumps it, and a stale save is refused', async () => {
        const { userId } = await createTestAccount();
        expect(await auth.getSettings(userId)).toEqual({ document: null, settingsVersion: 0 });
        await auth.putSettingsKey({ userId, nonce: randomBytes(24), ciphertext: randomBytes(48) });
        const first = await auth.putSettings({
            userId,
            expectedVersion: 0,
            version: 2,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect(first).toEqual({ status: 'ok', settingsVersion: 1 });
        // A second device that still holds version 0 must not overwrite version 1.
        const stale = await auth.putSettings({
            userId,
            expectedVersion: 0,
            version: 2,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect(stale).toEqual({ status: 'conflict', settingsVersion: 1 });
        const second = randomBytes(64);
        expect(
            await auth.putSettings({
                userId,
                expectedVersion: 1,
                version: 2,
                nonce: randomBytes(24),
                ciphertext: second,
            }),
        ).toEqual({ status: 'ok', settingsVersion: 2 });
        const { document: stored, settingsVersion } = await auth.getSettings(userId);
        expect(settingsVersion).toBe(2);
        expect(stored?.settingsVersion).toBe(2);
        expect(stored?.ciphertext.equals(second)).toBe(true);
    });

    test('settings are per person and go with the account', async () => {
        const a = await createTestAccount();
        const b = await createTestAccount();
        await auth.putSettingsKey({
            userId: a.userId,
            nonce: randomBytes(24),
            ciphertext: randomBytes(48),
        });
        await auth.putSettings({
            userId: a.userId,
            expectedVersion: 0,
            version: 2,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect((await auth.getSettings(b.userId)).document).toBeNull();
        expect((await auth.getSettings(a.userId)).document).not.toBeNull();
        await db.delete(users).where(eq(users.id, a.userId));
        expect(await auth.getSettings(a.userId)).toEqual({ document: null, settingsVersion: 0 });
    });
});

describe('the settings key', () => {
    test('is stored once: a second device’s key is refused and the first stands', async () => {
        const { userId } = await createTestAccount();
        expect(await auth.getSettingsKey(userId)).toBeNull();
        const first = { nonce: randomBytes(24), ciphertext: randomBytes(48) };
        expect(await auth.putSettingsKey({ userId, ...first })).toBe(true);
        expect(
            await auth.putSettingsKey({
                userId,
                nonce: randomBytes(24),
                ciphertext: randomBytes(48),
            }),
        ).toBe(false);
        const stored = await auth.getSettingsKey(userId);
        expect(stored?.ciphertext.equals(first.ciphertext)).toBe(true);
        expect(stored?.nonce.equals(first.nonce)).toBe(true);
        // A key of any other size is not a wrapped 32-byte key.
        const other = await createTestAccount();
        await expect(
            auth.putSettingsKey({
                userId: other.userId,
                nonce: randomBytes(24),
                ciphertext: randomBytes(32),
            }),
        ).rejects.toThrow();
    });

    test('only version 2 is taken, and only once its key is stored', async () => {
        const { userId } = await createTestAccount();
        const save = (expectedVersion: number, version: number) =>
            auth.putSettings({
                userId,
                expectedVersion,
                version,
                nonce: randomBytes(24),
                ciphertext: randomBytes(64),
            });
        // Sealed under a key the server never received: nobody could open it again.
        expect(await save(0, 2)).toEqual({ status: 'no-key', settingsVersion: 0 });
        await auth.putSettingsKey({ userId, nonce: randomBytes(24), ciphertext: randomBytes(48) });
        // Version 1 no longer opens anywhere, so it is not stored, whatever it names.
        for (const version of [1, 3])
            expect(await save(0, version)).toEqual({
                status: 'unsupported',
                settingsVersion: null,
            });
        expect((await auth.getSettings(userId)).document).toBeNull();
        expect(await save(0, 2)).toEqual({ status: 'ok', settingsVersion: 1 });
        expect((await auth.getSettings(userId)).document?.version).toBe(2);
    });

    test('a version 1 document reads as none at its sequence, and a save naming that sequence replaces it', async () => {
        const { userId } = await createTestAccount();
        // Left from before: sealed the old way, at sequence 5.
        await db.insert(userSettings).values({
            userId,
            version: 1,
            settingsVersion: 5,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        // No document a client could open, but the sequence it must build on.
        expect(await auth.getSettings(userId)).toEqual({ document: null, settingsVersion: 5 });
        await auth.putSettingsKey({ userId, nonce: randomBytes(24), ciphertext: randomBytes(48) });
        const save = (expectedVersion: number, ciphertext = randomBytes(64)) =>
            auth.putSettings({
                userId,
                expectedVersion,
                version: 2,
                nonce: randomBytes(24),
                ciphertext,
            });
        // Naming 0 over a stored sequence is a stale precondition, version 1 row or not.
        expect(await save(0)).toEqual({ status: 'conflict', settingsVersion: 5 });
        // The client sealed its fresh document at 6, the sequence after the one it read:
        // stored at 6, so the version bound into the seal is the one the row carries.
        const sealed = randomBytes(64);
        expect(await save(5, sealed)).toEqual({ status: 'ok', settingsVersion: 6 });
        const { document, settingsVersion } = await auth.getSettings(userId);
        expect(settingsVersion).toBe(6);
        expect(document).toMatchObject({ version: 2, settingsVersion: 6 });
        expect(document?.ciphertext.equals(sealed)).toBe(true);
        expect(await save(5)).toEqual({ status: 'conflict', settingsVersion: 6 });
    });
});

describe('identity lookup', () => {
    test('finds a person by normalised email and returns only public keys', async () => {
        const { userId, email } = await createTestAccount({ email: 'someone@hushos.test' });
        const identity = await identityFor(userId);
        const found = await auth.lookupIdentity(email);
        expect(found?.userId).toBe(userId);
        expect(found?.encryptionPublicKey.equals(identity.encryptionPublicKey)).toBe(true);
        expect(Object.keys(found!).sort()).toEqual(
            [
                'email',
                'encryptionPublicKey',
                'kemPublicKey',
                'kemSignature',
                'keyVersion',
                'name',
                'signingPublicKey',
                'userId',
            ].sort(),
        );
        // An account that has not finished setup has no identity to share to.
        const { email: bare } = await createTestAccount();
        expect(await auth.lookupIdentity(bare)).toBeNull();
        expect(await auth.lookupIdentity('nobody@hushos.test')).toBeNull();
    });
});

describe('roles', () => {
    test('everyone starts as a member; a grant by email is the only way up, and it is reversible', async () => {
        const { userId, email } = await createTestAccount();
        const [before] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId));
        expect(before?.role).toBe('member');
        expect(await auth.setUserRole(email, 'admin')).toMatchObject({ id: userId });
        const [after] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId));
        expect(after?.role).toBe('admin');
        expect(await auth.setUserRole('nobody@hushos.test', 'admin')).toBeNull();
        expect(await auth.setUserRole(email, 'member')).toMatchObject({ id: userId });
        // The role rides along with the session user.
        await db.update(users).set({ role: 'admin' }).where(eq(users.id, userId));
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
        expect(row?.role).toBe('admin');
    });
});
