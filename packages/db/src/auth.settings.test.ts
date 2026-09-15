import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import { accountIdentities, users } from './schema';

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
        expect(await auth.getSettings(userId)).toBeNull();
        const first = await auth.putSettings({
            userId,
            expectedVersion: 0,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect(first).toEqual({ status: 'ok', settingsVersion: 1 });
        // A second device that still holds version 0 must not overwrite version 1.
        const stale = await auth.putSettings({
            userId,
            expectedVersion: 0,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect(stale).toEqual({ status: 'conflict', settingsVersion: 1 });
        const second = randomBytes(64);
        expect(
            await auth.putSettings({
                userId,
                expectedVersion: 1,
                nonce: randomBytes(24),
                ciphertext: second,
            }),
        ).toEqual({ status: 'ok', settingsVersion: 2 });
        const stored = await auth.getSettings(userId);
        expect(stored?.settingsVersion).toBe(2);
        expect(stored?.ciphertext.equals(second)).toBe(true);
    });

    test('settings are per person and go with the account', async () => {
        const a = await createTestAccount();
        const b = await createTestAccount();
        await auth.putSettings({
            userId: a.userId,
            expectedVersion: 0,
            nonce: randomBytes(24),
            ciphertext: randomBytes(64),
        });
        expect(await auth.getSettings(b.userId)).toBeNull();
        await db.delete(users).where(eq(users.id, a.userId));
        expect(await auth.getSettings(a.userId)).toBeNull();
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
