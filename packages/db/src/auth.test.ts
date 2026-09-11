import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountEnrollments,
    accountIntents,
    billingCustomers,
    opaqueCredentials,
    sessions,
    storageEntitlements,
    users,
    workspaceKeys,
    workspaceStorage,
    workspaces,
} from './schema';

const HOUR = 60 * 60 * 1000;
const LIFETIME = { idleSeconds: 7 * 24 * 3600, maxSeconds: 30 * 24 * 3600 };

function hash(value: string) {
    return createHash('sha256').update(value).digest();
}
const bytes = (length: number) => randomBytes(length);

/* Byte shapes the schema's length checks accept; contents are irrelevant to the repository. */
function registration(workspaceId = randomUUID()) {
    return {
        initialQuotaBytes: 1_073_741_824n,
        name: 'Test Person',
        registrationRecord: 'record',
        profileVersion: 1,
        serverSetupId: 'primary',
        envelope: {
            envelopeVersion: 1,
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
        },
        recovery: {
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
            backupNonce: bytes(24),
            encryptedRecoveryKey: bytes(48),
            publicKey: bytes(32),
        },
        identity: {
            wrappingSalt: bytes(32),
            encryptionPublicKey: bytes(32),
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: bytes(32),
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
        },
        workspace: {
            id: workspaceId,
            grant: {
                keyVersion: 1,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
            },
        },
    };
}

/* The email flow's outcome: a verified enrollment identified by its enrollment token. */
async function verifiedEnrollment(
    email: string,
    options: {
        intent?: { plan?: string; referral?: string; source?: string };
        expired?: boolean;
    } = {},
) {
    const verification = randomUUID();
    const enrollment = randomUUID();
    await auth.createEnrollment({
        purpose: 'register',
        email,
        normalizedEmail: email,
        verificationTokenHash: hash(verification),
        expiresAt: new Date(Date.now() + HOUR),
        intent: options.intent,
    });
    const verified = await auth.verifyEnrollment(
        hash(verification),
        hash(enrollment),
        new Date(Date.now() + HOUR),
    );
    if (!verified) throw new Error('Enrollment did not verify.');
    if (options.expired) {
        // Age the row rather than verifying with a past expiry, which the
        // table's expiry-after-creation check rightly refuses.
        await db
            .update(accountEnrollments)
            .set({
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() - HOUR),
            })
            .where(eq(accountEnrollments.enrollmentTokenHash, hash(enrollment)));
    }
    return hash(enrollment);
}

async function registered(email = `${randomUUID()}@hushos.test`) {
    const token = await verifiedEnrollment(email);
    const result = await auth.registerAccount({ enrollmentTokenHash: token, ...registration() });
    if (result.status !== 'created') throw new Error(`Registration ${result.status}.`);
    return result.user;
}

async function signedIn(userId: string, credentialVersion = 1) {
    const token = randomUUID();
    const session = await auth.createSession({
        userId,
        credentialVersion,
        tokenHash: hash(token),
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!session) throw new Error('Session was not created.');
    return hash(token);
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('registerAccount', () => {
    test('creates the account, workspace, allowance and keys, and consumes the enrollment', async () => {
        const email = 'first@hushos.test';
        const token = await verifiedEnrollment(email, {
            intent: { plan: 'prod_pro', source: 'pricing' },
        });
        const result = await auth.registerAccount({
            enrollmentTokenHash: token,
            ...registration(),
        });
        expect(result.status).toBe('created');
        if (result.status !== 'created') return;

        expect(result.user.email).toBe(email);
        expect(await auth.getAccountKeyVersion(result.user.id)).toBe(1);
        expect((await auth.getStorageAllowance(result.user.id))?.quotaBytes).toBe('1073741824');
        // Nothing is left for the client to set up after registration.
        expect(await auth.getAccountSetup(result.user.id)).toMatchObject({
            recovery: false,
            identity: false,
            workspace: false,
            workspaceKey: false,
        });
        const [intent] = await db
            .select()
            .from(accountIntents)
            .where(eq(accountIntents.userId, result.user.id));
        expect(intent?.planProductId).toBe('prod_pro');
        expect(await auth.getEnrollment(token)).toBeNull();
        expect(
            await auth.registerAccount({ enrollmentTokenHash: token, ...registration() }),
        ).toEqual({
            status: 'expired',
        });
    });

    test('a second registration for the same email is refused without partial rows', async () => {
        const email = 'twice@hushos.test';
        await registered(email);
        const token = await verifiedEnrollment(email);
        const result = await auth.registerAccount({
            enrollmentTokenHash: token,
            ...registration(),
        });
        expect(result.status).toBe('exists');
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await db.select().from(workspaces)).toHaveLength(1);
    });

    test('an expired or unverified enrollment cannot register', async () => {
        const expired = await verifiedEnrollment('late@hushos.test', { expired: true });
        expect(
            await auth.registerAccount({ enrollmentTokenHash: expired, ...registration() }),
        ).toEqual({
            status: 'expired',
        });
        const unverified = randomUUID();
        await auth.createEnrollment({
            purpose: 'register',
            email: 'never@hushos.test',
            normalizedEmail: 'never@hushos.test',
            verificationTokenHash: hash(unverified),
            expiresAt: new Date(Date.now() + HOUR),
        });
        expect(
            await auth.registerAccount({
                enrollmentTokenHash: hash(unverified),
                ...registration(),
            }),
        ).toEqual({
            status: 'expired',
        });
        expect(await db.select().from(users)).toHaveLength(0);
    });
});

describe('sessions', () => {
    test('a session resolves to its user until the credential revision moves on', async () => {
        const user = await registered();
        const token = await signedIn(user.id);
        expect((await auth.getSessionUser(token, LIFETIME))?.id).toBe(user.id);

        // A password change bumps the credential revision; existing sessions must die with it.
        await db
            .update(opaqueCredentials)
            .set({ version: 2 })
            .where(eq(opaqueCredentials.userId, user.id));
        expect(await auth.getSessionUser(token, LIFETIME)).toBeNull();
    });

    test('a session cannot be created for a credential revision that does not exist', async () => {
        const user = await registered();
        expect(
            await auth.createSession({
                userId: user.id,
                credentialVersion: 2,
                tokenHash: hash(randomUUID()),
                previousTokenHash: null,
                expiresAt: new Date(Date.now() + HOUR),
            }),
        ).toBeNull();
    });

    test('expiry and the absolute cap both end a session', async () => {
        const user = await registered();
        const token = await signedIn(user.id);
        await db
            .update(sessions)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(sessions.tokenHash, token));
        expect(await auth.getSessionUser(token, LIFETIME)).toBeNull();

        const fresh = await signedIn(user.id);
        await db
            .update(sessions)
            .set({ createdAt: new Date(Date.now() - (LIFETIME.maxSeconds + 1) * 1000) })
            .where(eq(sessions.tokenHash, fresh));
        expect(await auth.getSessionUser(fresh, LIFETIME)).toBeNull();
    });
});

describe('deleteAccount', () => {
    test('refuses without a live session bound to the current credential revision', async () => {
        const user = await registered();
        const token = await signedIn(user.id);
        expect(
            await auth.deleteAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: hash('other'),
            }),
        ).toBe(false);
        expect(
            await auth.deleteAccount({
                userId: user.id,
                credentialVersion: 2,
                sessionTokenHash: token,
            }),
        ).toBe(false);
        expect(await db.select().from(users)).toHaveLength(1);
    });

    test('removes the account and everything hanging off it', async () => {
        const email = 'gone@hushos.test';
        const user = await registered(email);
        const token = await signedIn(user.id);
        const allowance = await auth.getStorageAllowance(user.id);
        if (!allowance) throw new Error('No allowance.');
        await db
            .insert(billingCustomers)
            .values({ userId: user.id, provider: 'polar', providerCustomerId: 'cus_1' });
        await db.insert(storageEntitlements).values({
            workspaceId: allowance.workspaceId,
            source: 'polar',
            sourceReference: 'sub_1',
            quotaBytes: 1n,
        });
        // A pending recovery enrollment for the same email must not survive the account.
        await auth.createEnrollment({
            purpose: 'recover',
            email,
            normalizedEmail: email,
            verificationTokenHash: hash('pending'),
            expiresAt: new Date(Date.now() + HOUR),
        });

        expect(
            await auth.deleteAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: token,
            }),
        ).toBe(true);
        expect(await db.select().from(users)).toHaveLength(0);
        expect(await db.select().from(workspaces)).toHaveLength(0);
        expect(await db.select().from(workspaceStorage)).toHaveLength(0);
        expect(await db.select().from(workspaceKeys)).toHaveLength(0);
        expect(await db.select().from(storageEntitlements)).toHaveLength(0);
        expect(await db.select().from(billingCustomers)).toHaveLength(0);
        expect(await db.select().from(sessions)).toHaveLength(0);
        expect(await db.select().from(accountEnrollments)).toHaveLength(0);
    });
});
