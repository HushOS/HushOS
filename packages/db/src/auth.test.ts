import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
    closeDatabase,
    hybridSignerFromSeed,
    resetDatabase,
    type HybridSigner,
} from '../test/helpers';
import { keysStatement, successionStatement } from './signatures';
import * as auth from './auth';
import { db } from './client';
import {
    accountEnrollments,
    accountIdentities,
    accountRecoveryKeys,
    accountIdentityHistory,
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

/*
 * Every nested part of an input carries its fields only: an account id (or a workspace id) inside
 * one is never what a row is written under. The account is the one the call names.
 */
describe('nested input never names the account', () => {
    const claiming = <T extends object>(part: T, userId: string, workspaceId?: string) =>
        ({ ...part, userId, ...(workspaceId ? { workspaceId } : {}) }) as T;

    test('registerAccount writes every key row under the new account, whatever the parts claim', async () => {
        const victim = await registered();
        const [before] = await db
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, victim.id));
        const [victimGrant] = await db
            .select()
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, victim.id));
        const parts = registration();
        const result = await auth.registerAccount({
            enrollmentTokenHash: await verifiedEnrollment(`${randomUUID()}@hushos.test`),
            ...parts,
            envelope: claiming(parts.envelope, victim.id),
            recovery: claiming(parts.recovery, victim.id),
            identity: claiming(parts.identity, victim.id),
            workspace: {
                ...parts.workspace,
                grant: claiming(parts.workspace.grant, victim.id, victimGrant!.workspaceId),
            },
        });
        expect(result.status).toBe('created');
        if (result.status !== 'created') return;
        const [identity] = await db
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, result.user.id));
        expect(identity!.signingPublicKey).toEqual(parts.identity.signingPublicKey);
        const [recovery] = await db
            .select()
            .from(accountRecoveryKeys)
            .where(eq(accountRecoveryKeys.userId, result.user.id));
        expect(recovery!.publicKey).toEqual(parts.recovery.publicKey);
        const grants = await db
            .select()
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, result.user.id));
        expect(grants.map((g) => g.workspaceId)).toEqual([parts.workspace.id]);
        // The account named inside the parts is untouched.
        const [after] = await db
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, victim.id));
        expect(after).toEqual(before);
        expect(
            await db.select().from(workspaceKeys).where(eq(workspaceKeys.userId, victim.id)),
        ).toEqual([victimGrant]);
    });

    test('initializeAccount writes recovery, identity and grant under the signed-in account, whatever the parts claim', async () => {
        const user = await registered();
        const victim = await registered();
        await db.delete(accountRecoveryKeys).where(eq(accountRecoveryKeys.userId, user.id));
        await db.delete(accountIdentities).where(eq(accountIdentities.userId, user.id));
        const [grant] = await db
            .select()
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, user.id));
        await db.delete(workspaceKeys).where(eq(workspaceKeys.userId, user.id));
        const [victimGrant] = await db
            .select()
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, victim.id));
        const parts = registration();
        expect(
            await auth.initializeAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: await signedIn(user.id),
                initialQuotaBytes: 1_073_741_824n,
                recovery: claiming(parts.recovery, victim.id),
                identity: claiming(parts.identity, victim.id),
                workspace: {
                    id: grant!.workspaceId,
                    grant: claiming(parts.workspace.grant, victim.id, victimGrant!.workspaceId),
                },
            }),
        ).toBe(true);
        const [identity] = await db
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, user.id));
        expect(identity!.signingPublicKey).toEqual(parts.identity.signingPublicKey);
        const [recovery] = await db
            .select()
            .from(accountRecoveryKeys)
            .where(eq(accountRecoveryKeys.userId, user.id));
        expect(recovery!.publicKey).toEqual(parts.recovery.publicKey);
        const grants = await db
            .select()
            .from(workspaceKeys)
            .where(eq(workspaceKeys.userId, user.id));
        expect(grants.map((g) => [g.workspaceId, g.keyVersion])).toEqual([[grant!.workspaceId, 1]]);
        expect(
            await db.select().from(workspaceKeys).where(eq(workspaceKeys.userId, victim.id)),
        ).toEqual([victimGrant]);
    });
});

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

describe('suspension', () => {
    test('ends every session, refuses a new one, and lifts cleanly', async () => {
        const user = await registered();
        const token = await signedIn(user.id);
        expect((await auth.getSessionUser(token, LIFETIME))?.id).toBe(user.id);

        const suspended = await auth.setUserSuspended(user.id, true);
        expect(suspended?.suspendedAt).not.toBeNull();
        expect(await auth.getSessionUser(token, LIFETIME)).toBeNull();
        expect(await db.select().from(sessions)).toHaveLength(0);
        expect(
            await auth.createSession({
                userId: user.id,
                credentialVersion: 1,
                tokenHash: hash(randomUUID()),
                previousTokenHash: null,
                expiresAt: new Date(Date.now() + HOUR),
            }),
        ).toEqual({ suspended: true });
        // Suspending twice keeps the first timestamp; lifting clears it and sign-in works again.
        const again = await auth.setUserSuspended(user.id, true);
        expect(again?.suspendedAt?.getTime()).toBe(suspended?.suspendedAt?.getTime());
        expect((await auth.setUserSuspended(user.id, false))?.suspendedAt).toBeNull();
        const back = await signedIn(user.id);
        expect((await auth.getSessionUser(back, LIFETIME))?.id).toBe(user.id);
        expect(await auth.setUserSuspended(randomUUID(), true)).toBeNull();
    });
});

describe('server secrets', () => {
    test('a secret is made once and every process reads that one, even when they race', async () => {
        const first = await auth.ensureServerSecret('opaque-setup:test', () => 'made-first');
        expect(first).toBe('made-first');
        expect(await auth.ensureServerSecret('opaque-setup:test', () => 'made-again')).toBe(
            'made-first',
        );
        // Ten processes starting at once against an empty table agree on one value.
        const values = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                auth.ensureServerSecret('opaque-setup:raced', () => `candidate-${i}`),
            ),
        );
        expect(new Set(values).size).toBe(1);
        expect(values[0]).toMatch(/^candidate-\d$/);
        // Names are separate secrets.
        expect(await auth.ensureServerSecret('other', () => 'other-value')).toBe('other-value');
    });
});

/*
 * Identities as the repository stores them (docs/identity-pq-design.md): a
 * version 1 identity upgrades in place to version 2, and a version 2 identity
 * is replaced only by a succession its current hybrid keys signed. Keys are
 * real where a signature is checked; the rest are bytes of the right length.
 */
const seedOf = (label: string) => createHash('sha256').update(label).digest();
const kemHalf = () => ({
    kemPublicKey: bytes(1184),
    kemSeedNonce: bytes(24),
    encryptedKemSeed: bytes(80),
});
/* The lattice half of a version 2 identity for `signer`, with a keys statement it signed. */
function v2Fields(
    userId: string,
    signer: HybridSigner,
    base: {
        keyVersion: number;
        encryptionPublicKey: Buffer;
        kemPublicKey: Buffer;
    },
) {
    return {
        version: 2 as const,
        signingPublicKey: signer.signingPublicKey,
        mlDsaPublicKey: signer.mlDsaPublicKey,
        mlDsaSeedNonce: bytes(24),
        encryptedMlDsaSeed: bytes(48),
        kemSignature: null,
        keysSignature: signer.sign(
            keysStatement({
                userId,
                keyVersion: base.keyVersion,
                encryptionPublicKey: base.encryptionPublicKey,
                signingPublicKey: signer.signingPublicKey,
                mlDsaPublicKey: signer.mlDsaPublicKey,
                kemPublicKey: base.kemPublicKey,
            }),
        ),
    };
}
/* A new version 2 identity row at `keyVersion` for `signer`. */
function freshV2(userId: string, signer: HybridSigner, keyVersion: number) {
    const encryptionPublicKey = bytes(32);
    const kem = kemHalf();
    return {
        keyVersion,
        wrappingSalt: bytes(32),
        encryptionPublicKey,
        encryptionPrivateKeyNonce: bytes(24),
        encryptedEncryptionPrivateKey: bytes(48),
        signingSeedNonce: bytes(24),
        encryptedSigningSeed: bytes(48),
        ...kem,
        ...v2Fields(userId, signer, {
            keyVersion,
            encryptionPublicKey,
            kemPublicKey: kem.kemPublicKey,
        }),
    };
}

describe('the upgrade to a version 2 identity', () => {
    /* A registered account with a version 1 identity whose Ed25519 key is real. */
    async function v1Account(email: string, withKem = true) {
        const user = await registered(email);
        const signer = hybridSignerFromSeed(seedOf(`upgrade:${email}`));
        await db
            .update(accountIdentities)
            .set({
                signingPublicKey: signer.signingPublicKey,
                ...(withKem ? { ...kemHalf(), kemSignature: bytes(64) } : {}),
            })
            .where(eq(accountIdentities.userId, user.id));
        return { user, signer, sessionTokenHash: await signedIn(user.id) };
    }
    /* The upgrade of the stored identity: the same keys and version, plus the lattice half. */
    async function upgradeOf(userId: string, signer: HybridSigner) {
        const current = (await auth.getIdentity(userId))!;
        const kemPublicKey = current.kemPublicKey ?? bytes(1184);
        return {
            keyVersion: current.keyVersion,
            wrappingSalt: current.wrappingSalt,
            encryptionPublicKey: current.encryptionPublicKey,
            encryptionPrivateKeyNonce: current.encryptionPrivateKeyNonce,
            encryptedEncryptionPrivateKey: current.encryptedEncryptionPrivateKey,
            signingSeedNonce: current.signingSeedNonce,
            encryptedSigningSeed: current.encryptedSigningSeed,
            kemPublicKey,
            kemSeedNonce: current.kemSeedNonce ?? bytes(24),
            encryptedKemSeed: current.encryptedKemSeed ?? bytes(80),
            ...v2Fields(userId, signer, {
                keyVersion: current.keyVersion,
                encryptionPublicKey: current.encryptionPublicKey,
                kemPublicKey,
            }),
        };
    }

    test('keeps the keys and the key version, stores the lattice half once, and serves it', async () => {
        const { user, signer, sessionTokenHash } = await v1Account('upgrade@hushos.test');
        const before = (await auth.getIdentity(user.id))!;
        const identity = await upgradeOf(user.id, signer);
        expect(auth.identityKeysHold(user.id, identity)).toBe(true);
        expect(
            await auth.upgradeIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
            }),
        ).toEqual({ status: 'ok' });
        const after = (await auth.getIdentity(user.id))!;
        expect(after.version).toBe(2);
        expect(after.keyVersion).toBe(before.keyVersion);
        expect(after.signingPublicKey.equals(before.signingPublicKey)).toBe(true);
        expect(after.kemPublicKey!.equals(before.kemPublicKey!)).toBe(true);
        // The Ed25519 KEM binding is no longer a path to trust, and is dropped.
        expect(after.kemSignature).toBeNull();
        // No history and no succession: nothing about the account's past changes.
        expect(await auth.listIdentityHistory(user.id)).toEqual([]);
        const served = await auth.lookupIdentity('upgrade@hushos.test');
        expect(served?.identityVersion).toBe(2);
        expect(served?.mlDsaPublicKey?.equals(signer.mlDsaPublicKey)).toBe(true);
        expect(served?.keysSignature?.equals(identity.keysSignature)).toBe(true);
        // A second device that raced is handed the identity that won, not a second ML-DSA key.
        const other = hybridSignerFromSeed(seedOf('second device'));
        const second = await auth.upgradeIdentity({
            userId: user.id,
            credentialVersion: 1,
            sessionTokenHash,
            identity: { ...identity, ...v2Fields(user.id, other, identity) },
        });
        expect(second.status).toBe('stale');
        if (second.status === 'stale')
            expect(second.current.mlDsaPublicKey!.equals(signer.mlDsaPublicKey)).toBe(true);
        expect(
            (await auth.getIdentity(user.id))!.mlDsaPublicKey!.equals(signer.mlDsaPublicKey),
        ).toBe(true);
    });

    test('gives an identity from before hybrid sharing its ML-KEM key in the same step', async () => {
        const { user, signer, sessionTokenHash } = await v1Account(
            'upgrade-nokem@hushos.test',
            false,
        );
        expect((await auth.getIdentity(user.id))!.kemPublicKey).toBeNull();
        const identity = await upgradeOf(user.id, signer);
        expect(
            await auth.upgradeIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
            }),
        ).toEqual({ status: 'ok' });
        expect((await auth.getIdentity(user.id))!.kemPublicKey!.equals(identity.kemPublicKey)).toBe(
            true,
        );
    });

    test('refuses an upgrade that changes a key or the key version, and changes nothing', async () => {
        const { user, signer, sessionTokenHash } = await v1Account('upgrade-swap@hushos.test');
        const identity = await upgradeOf(user.id, signer);
        for (const swapped of [
            { ...identity, encryptionPublicKey: bytes(32) },
            { ...identity, kemPublicKey: bytes(1184) },
            { ...identity, keyVersion: 2 },
            {
                ...identity,
                ...v2Fields(user.id, hybridSignerFromSeed(seedOf('stranger')), identity),
            },
            // The same public keys with new wraps of their private halves: a client bug that
            // would leave the account unable to open its keys.
            { ...identity, wrappingSalt: bytes(32) },
            { ...identity, encryptedSigningSeed: bytes(48) },
            { ...identity, encryptedEncryptionPrivateKey: bytes(48) },
            { ...identity, encryptedKemSeed: bytes(80) },
            { ...identity, encryptionPrivateKeyNonce: bytes(24) },
            { ...identity, signingSeedNonce: bytes(24) },
            { ...identity, kemSeedNonce: bytes(24) },
        ])
            expect(
                await auth.upgradeIdentity({
                    userId: user.id,
                    credentialVersion: 1,
                    sessionTokenHash,
                    identity: swapped,
                }),
            ).toEqual({ status: 'mismatch' });
        expect((await auth.getIdentity(user.id))!.version).toBe(1);
        // A session a sign-out ended does nothing either.
        expect(
            await auth.upgradeIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: hash('no such session'),
                identity,
            }),
        ).toEqual({ status: 'session' });
    });

    test('the keys statement holds only for its own keys, account and version', async () => {
        const user = await registered('keys@hushos.test');
        const signer = hybridSignerFromSeed(seedOf('keys'));
        const identity = freshV2(user.id, signer, 1);
        expect(auth.identityKeysHold(user.id, identity)).toBe(true);
        expect(auth.identityKeysHold(randomUUID(), identity)).toBe(false);
        expect(auth.identityKeysHold(user.id, { ...identity, keyVersion: 2 })).toBe(false);
        expect(auth.identityKeysHold(user.id, { ...identity, kemPublicKey: bytes(1184) })).toBe(
            false,
        );
        expect(
            auth.identityKeysHold(user.id, {
                ...identity,
                mlDsaPublicKey: hybridSignerFromSeed(seedOf('other')).mlDsaPublicKey,
            }),
        ).toBe(false);
        // Its Ed25519 half alone, padded to length or not, is not the statement's signature.
        const classical = signer.signClassical(keysStatement({ userId: user.id, ...identity }));
        expect(auth.identityKeysHold(user.id, { ...identity, keysSignature: classical })).toBe(
            false,
        );
        expect(
            auth.identityKeysHold(user.id, {
                ...identity,
                keysSignature: Buffer.concat([classical, Buffer.alloc(3309)]),
            }),
        ).toBe(false);
        // A version 2 row missing any one lattice field is refused by the table itself, with
        // everything else present (a check over an empty column would otherwise pass as unknown).
        const complete = freshV2(user.id, signer, 1);
        for (const missing of [
            'mlDsaPublicKey',
            'mlDsaSeedNonce',
            'encryptedMlDsaSeed',
            'keysSignature',
        ] as const)
            await expect(
                db
                    .update(accountIdentities)
                    .set({ ...complete, [missing]: null })
                    .where(eq(accountIdentities.userId, user.id)),
            ).rejects.toThrow();
        // The same row, complete, is stored.
        await db
            .update(accountIdentities)
            .set(complete)
            .where(eq(accountIdentities.userId, user.id));
        expect((await auth.getIdentity(user.id))!.version).toBe(2);
    });
});

describe('identity succession', () => {
    /* A registered account whose version 2 identity signs for real, at key version 1. */
    async function account(email: string) {
        const user = await registered(email);
        const signer = hybridSignerFromSeed(seedOf(`old:${email}`));
        await db
            .update(accountIdentities)
            .set(freshV2(user.id, signer, 1))
            .where(eq(accountIdentities.userId, user.id));
        return { user, signer, sessionTokenHash: await signedIn(user.id) };
    }
    /* A new identity at `keyVersion`, and the current keys' hybrid signature over its succession. */
    async function successor(
        userId: string,
        signer: HybridSigner,
        keyVersion: number,
        label: string,
    ) {
        const current = (await auth.getIdentity(userId))!;
        const next = hybridSignerFromSeed(seedOf(`new:${label}`));
        const identity = freshV2(userId, next, keyVersion);
        const statement = successionStatement({
            userId,
            oldKeyVersion: current.keyVersion,
            newKeyVersion: keyVersion,
            oldEncryptionPublicKey: current.encryptionPublicKey,
            oldSigningPublicKey: current.signingPublicKey,
            oldMlDsaPublicKey: current.mlDsaPublicKey!,
            newEncryptionPublicKey: identity.encryptionPublicKey,
            newSigningPublicKey: identity.signingPublicKey,
            newMlDsaPublicKey: identity.mlDsaPublicKey,
            newKemPublicKey: identity.kemPublicKey,
        });
        return { identity, next, statement, signature: signer.sign(statement) };
    }

    test('replaces the identity and keeps the old one, still sealed, with its hybrid succession', async () => {
        const { user, signer, sessionTokenHash } = await account('succeed@hushos.test');
        const before = (await auth.getIdentity(user.id))!;
        const { identity, signature } = await successor(user.id, signer, 2, 'a');
        expect(signature).toHaveLength(3373);
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
                signature,
            }),
        ).toEqual({ status: 'ok', keyVersion: 2 });
        const now = (await auth.getIdentity(user.id))!;
        expect(now.keyVersion).toBe(2);
        expect(now.mlDsaPublicKey!.equals(identity.mlDsaPublicKey)).toBe(true);
        const served = await auth.lookupIdentity('succeed@hushos.test');
        expect(served?.keyVersion).toBe(2);
        expect(served?.signingPublicKey.equals(identity.signingPublicKey)).toBe(true);
        // The old envelope, byte for byte, so the account's devices still open shares sealed to it.
        const [old] = await auth.listIdentityHistory(user.id);
        expect(old).toMatchObject({ keyVersion: 1, replacedByKeyVersion: 2, version: 2 });
        for (const field of [
            'wrappingSalt',
            'encryptionPublicKey',
            'encryptedEncryptionPrivateKey',
            'signingPublicKey',
            'encryptedSigningSeed',
            'kemPublicKey',
            'encryptedKemSeed',
            'mlDsaPublicKey',
            'encryptedMlDsaSeed',
            'keysSignature',
        ] as const)
            expect(old![field]?.equals(before[field]!)).toBe(true);
        expect(old!.newMlDsaPublicKey!.equals(identity.mlDsaPublicKey)).toBe(true);
        expect(old!.successionSignature.equals(signature)).toBe(true);
    });

    test('refuses a key version other than the next one, and changes nothing', async () => {
        const { user, signer, sessionTokenHash } = await account('version@hushos.test');
        for (const keyVersion of [1, 3]) {
            const { identity, signature } = await successor(user.id, signer, keyVersion, 'v');
            expect(
                await auth.succeedIdentity({
                    userId: user.id,
                    credentialVersion: 1,
                    sessionTokenHash,
                    identity,
                    signature,
                }),
            ).toEqual({ status: 'stale' });
        }
        expect((await auth.getIdentity(user.id))?.keyVersion).toBe(1);
        expect(await auth.listIdentityHistory(user.id)).toEqual([]);
    });

    test('refuses a succession not signed by both current keys, or not the one stored', async () => {
        const { user, signer, sessionTokenHash } = await account('forged@hushos.test');
        const attempt = (
            identity: Parameters<typeof auth.succeedIdentity>[0]['identity'],
            signature: Buffer,
        ) =>
            auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
                signature,
            });
        const made = await successor(user.id, signer, 2, 'b');
        // Signed by the new keys: anyone holding only the new identity could make that.
        expect(await attempt(made.identity, made.next.sign(made.statement))).toEqual({
            status: 'bad-signature',
        });
        // Ed25519 alone, as version 1 signed: the statement is a hybrid one.
        expect(await attempt(made.identity, signer.signClassical(made.statement))).toEqual({
            status: 'bad-signature',
        });
        // The current Ed25519 half beside an ML-DSA half by another key, as a quantum forger
        // of Ed25519 could make.
        const forger = hybridSignerFromSeed(seedOf('forger'));
        expect(
            await attempt(
                made.identity,
                Buffer.concat([
                    signer.signClassical(made.statement),
                    forger.signLattice(made.statement),
                ]),
            ),
        ).toEqual({ status: 'bad-signature' });
        // A genuine signature, but the server is handed other keys than the ones signed.
        expect(
            await attempt({ ...made.identity, kemPublicKey: bytes(1184) }, made.signature),
        ).toEqual({
            status: 'bad-signature',
        });
        expect(
            await attempt(
                { ...made.identity, mlDsaPublicKey: forger.mlDsaPublicKey },
                made.signature,
            ),
        ).toEqual({ status: 'bad-signature' });
        // The same keys again are not a succession.
        const current = (await auth.getIdentity(user.id))!;
        expect(
            await attempt(
                { ...made.identity, mlDsaPublicKey: current.mlDsaPublicKey! },
                made.signature,
            ),
        ).toEqual({ status: 'unchanged' });
        expect((await auth.getIdentity(user.id))?.keyVersion).toBe(1);
    });

    test('refuses a succession from a version 1 identity, and from an ended session', async () => {
        const user = await registered('v1-succeed@hushos.test');
        const sessionTokenHash = await signedIn(user.id);
        const next = hybridSignerFromSeed(seedOf('v1-next'));
        const identity = freshV2(user.id, next, 2);
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
                signature: Buffer.alloc(3373),
            }),
        ).toEqual({ status: 'not-upgraded' });
        const { user: other, signer } = await account('ended@hushos.test');
        const made = await successor(other.id, signer, 2, 'c');
        expect(
            await auth.succeedIdentity({
                userId: other.id,
                credentialVersion: 1,
                sessionTokenHash: hash('no such session'),
                identity: made.identity,
                signature: made.signature,
            }),
        ).toEqual({ status: 'session' });
    });

    test('refuses a succession past the earlier identities a master-key rotation can carry', async () => {
        const { user, signer, sessionTokenHash } = await account('history-full@hushos.test');
        const succeed = async (from: HybridSigner, keyVersion: number, label: string) => {
            const made = await successor(user.id, from, keyVersion, label);
            const result = await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity: made.identity,
                signature: made.signature,
            });
            return { result, next: made.next };
        };
        const first = await succeed(signer, 2, 'full-1');
        expect(first.result).toEqual({ status: 'ok', keyVersion: 2 });
        // Copies of that history row stand in for the successions up to one short of the limit.
        const [row] = await db
            .select()
            .from(accountIdentityHistory)
            .where(eq(accountIdentityHistory.userId, user.id));
        const filler = Array.from({ length: auth.IDENTITY_HISTORY_LIMIT - 2 }, (_, index) => ({
            ...row!,
            keyVersion: index + 2,
            replacedByKeyVersion: index + 3,
        }));
        await db.insert(accountIdentityHistory).values(filler);
        const last = auth.IDENTITY_HISTORY_LIMIT;
        await db
            .update(accountIdentities)
            .set({ keyVersion: last })
            .where(eq(accountIdentities.userId, user.id));
        const atLimit = await succeed(first.next, last + 1, 'full-2');
        expect(atLimit.result).toEqual({ status: 'ok', keyVersion: last + 1 });
        expect(await auth.listIdentityHistory(user.id)).toHaveLength(auth.IDENTITY_HISTORY_LIMIT);
        // What sizes the body a master-key rotation may send for this account.
        expect(await auth.countIdentityHistory(user.id)).toBe(auth.IDENTITY_HISTORY_LIMIT);
        const past = await succeed(atLimit.next, last + 2, 'full-3');
        expect(past.result).toEqual({ status: 'history-full' });
        expect((await auth.getIdentity(user.id))?.keyVersion).toBe(last + 1);
    });

    test('the chain lists each succession in order from the version asked for, ML-DSA keys included', async () => {
        const { user, signer, sessionTokenHash } = await account('chain@hushos.test');
        const first = await successor(user.id, signer, 2, 'chain-1');
        await auth.succeedIdentity({
            userId: user.id,
            credentialVersion: 1,
            sessionTokenHash,
            ...first,
        });
        const second = await successor(user.id, first.next, 3, 'chain-2');
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                ...second,
            }),
        ).toEqual({ status: 'ok', keyVersion: 3 });
        const chain = await auth.successionChain(user.id, 1);
        expect(chain?.map((link) => [link.oldKeyVersion, link.newKeyVersion])).toEqual([
            [1, 2],
            [2, 3],
        ]);
        // Each link names the keys it hands over to, and the next starts from them.
        expect(chain![0]!.newMlDsaPublicKey!.equals(first.identity.mlDsaPublicKey)).toBe(true);
        expect(chain![1]!.oldMlDsaPublicKey!.equals(first.identity.mlDsaPublicKey)).toBe(true);
        expect(chain![1]!.oldSigningPublicKey.equals(first.identity.signingPublicKey)).toBe(true);
        expect(chain![1]!.newKemPublicKey.equals(second.identity.kemPublicKey)).toBe(true);
        expect(chain![1]!.signature.equals(second.signature)).toBe(true);
        expect((await auth.successionChain(user.id, 2))?.map((l) => l.oldKeyVersion)).toEqual([2]);
        expect(await auth.successionChain(user.id, 3)).toEqual([]);
        expect(await auth.successionChain(randomUUID(), 1)).toBeNull();
    });

    test('a master-key rotation re-wraps every earlier identity, keeps the lattice keys, and never moves a version 2 key version', async () => {
        const workspaceId = randomUUID();
        const created = await auth.registerAccount({
            enrollmentTokenHash: await verifiedEnrollment('rewrap@hushos.test'),
            ...registration(workspaceId),
        });
        if (created.status !== 'created') throw new Error(created.status);
        const user = created.user;
        const signer = hybridSignerFromSeed(seedOf('old:rewrap'));
        await db
            .update(accountIdentities)
            .set(freshV2(user.id, signer, 1))
            .where(eq(accountIdentities.userId, user.id));
        const sessionTokenHash = await signedIn(user.id);
        const succession = await successor(user.id, signer, 2, 'rewrap');
        await auth.succeedIdentity({
            userId: user.id,
            credentialVersion: 1,
            sessionTokenHash,
            ...succession,
        });
        const current = (await auth.getIdentity(user.id))!;
        const [old] = await auth.listIdentityHistory(user.id);
        const rewrap = <T extends typeof current | typeof old>(row: T, keyVersion: number) => ({
            version: row!.version,
            keyVersion,
            wrappingSalt: bytes(32),
            encryptionPublicKey: row!.encryptionPublicKey,
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: row!.signingPublicKey,
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
            kemPublicKey: row!.kemPublicKey,
            kemSeedNonce: bytes(24),
            encryptedKemSeed: bytes(80),
            kemSignature: row!.kemSignature,
            mlDsaPublicKey: row!.mlDsaPublicKey,
            mlDsaSeedNonce: bytes(24),
            encryptedMlDsaSeed: bytes(48),
            keysSignature: row!.keysSignature,
        });
        // The account root is at version 1 and goes to 2; the identity is at 2.
        const change = (
            identity: ReturnType<typeof rewrap>,
            identityHistory: ReturnType<typeof rewrap>[] | undefined,
        ) =>
            auth.changeAccountSecurity({
                userId: user.id,
                action: 'master-key',
                sessionTokenHash,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: {
                    keyVersion: 2,
                    wrappingSalt: bytes(32),
                    wrappingNonce: bytes(24),
                    encryptedKey: bytes(48),
                },
                recovery: {
                    keyVersion: 2,
                    recoveryVersion: 2,
                    wrappingSalt: bytes(32),
                    wrappingNonce: bytes(24),
                    encryptedKey: bytes(48),
                    backupNonce: bytes(24),
                    encryptedRecoveryKey: bytes(48),
                    publicKey: bytes(32),
                },
                identity,
                identityHistory,
                workspaces: [
                    {
                        id: workspaceId,
                        grant: {
                            keyVersion: 2,
                            workspaceKeyVersion: 1,
                            wrappingSalt: bytes(32),
                            wrappingNonce: bytes(24),
                            encryptedKey: bytes(48),
                        },
                    },
                ],
            });
        const history = rewrap(old, 1);
        // Left behind under the old root, the earlier identity would be lost with it.
        expect(await change(rewrap(current, 2), undefined)).toBe(false);
        // A history entry or a current identity that changes a public key is not a re-wrap.
        expect(
            await change(rewrap(current, 2), [{ ...history, signingPublicKey: bytes(32) }]),
        ).toBe(false);
        expect(
            await change(
                {
                    ...rewrap(current, 2),
                    mlDsaPublicKey: hybridSignerFromSeed(seedOf('swap')).mlDsaPublicKey,
                },
                [history],
            ),
        ).toBe(false);
        expect(await change({ ...rewrap(current, 2), keysSignature: bytes(3373) }, [history])).toBe(
            false,
        );
        // The keys statement binds the key version: a version 2 identity's never moves, up or down.
        expect(await change(rewrap(current, 1), [history])).toBe(false);
        expect(await change(rewrap(current, 3), [history])).toBe(false);
        expect(await change(rewrap(current, 2), [history])).toBe(true);
        const [after] = await auth.listIdentityHistory(user.id);
        expect(after!.encryptedMlDsaSeed!.equals(history.encryptedMlDsaSeed)).toBe(true);
        expect(after!.mlDsaPublicKey!.equals(old!.mlDsaPublicKey!)).toBe(true);
        expect(after!.successionSignature.equals(old!.successionSignature)).toBe(true);
        const now = (await auth.getIdentity(user.id))!;
        expect(now.keyVersion).toBe(2);
        expect(now.mlDsaPublicKey!.equals(current.mlDsaPublicKey!)).toBe(true);
    });
});

describe('the settings key in a master-key rotation', () => {
    test('is re-wrapped with the root when the account has one, and only then', async () => {
        const workspaceId = randomUUID();
        const created = await auth.registerAccount({
            enrollmentTokenHash: await verifiedEnrollment('settings-key@hushos.test'),
            ...registration(workspaceId),
        });
        if (created.status !== 'created') throw new Error(created.status);
        const user = created.user;
        const sessionTokenHash = await signedIn(user.id);
        const stored = (await auth.getIdentity(user.id))!;
        const change = (
            action: 'master-key' | 'password',
            settingsKey: { nonce: Buffer; ciphertext: Buffer } | undefined,
        ) =>
            auth.changeAccountSecurity({
                userId: user.id,
                action,
                sessionTokenHash,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: {
                    keyVersion: action === 'master-key' ? 2 : 1,
                    wrappingSalt: bytes(32),
                    wrappingNonce: bytes(24),
                    encryptedKey: bytes(48),
                },
                recovery:
                    action === 'master-key'
                        ? {
                              keyVersion: 2,
                              recoveryVersion: 2,
                              wrappingSalt: bytes(32),
                              wrappingNonce: bytes(24),
                              encryptedKey: bytes(48),
                              backupNonce: bytes(24),
                              encryptedRecoveryKey: bytes(48),
                              publicKey: bytes(32),
                          }
                        : undefined,
                identity:
                    action === 'master-key'
                        ? {
                              keyVersion: 2,
                              wrappingSalt: bytes(32),
                              encryptionPublicKey: stored.encryptionPublicKey,
                              encryptionPrivateKeyNonce: bytes(24),
                              encryptedEncryptionPrivateKey: bytes(48),
                              signingPublicKey: stored.signingPublicKey,
                              signingSeedNonce: bytes(24),
                              encryptedSigningSeed: bytes(48),
                          }
                        : undefined,
                settingsKey,
                workspaces:
                    action === 'master-key'
                        ? [
                              {
                                  id: workspaceId,
                                  grant: {
                                      keyVersion: 2,
                                      workspaceKeyVersion: 1,
                                      wrappingSalt: bytes(32),
                                      wrappingNonce: bytes(24),
                                      encryptedKey: bytes(48),
                                  },
                              },
                          ]
                        : undefined,
            });
        const rewrapped = { nonce: bytes(24), ciphertext: bytes(48) };
        // No key stored yet: a rotation carrying one would invent it.
        expect(await change('master-key', rewrapped)).toBe(false);
        await auth.putSettingsKey({ userId: user.id, nonce: bytes(24), ciphertext: bytes(48) });
        // A key stored and not carried along would stay sealed under a root that is gone.
        expect(await change('master-key', undefined)).toBe(false);
        // A password change keeps the root, so it has no settings key to carry.
        expect(await change('password', rewrapped)).toBe(false);
        expect(await change('master-key', rewrapped)).toBe(true);
        const now = await auth.getSettingsKey(user.id);
        expect(now?.ciphertext.equals(rewrapped.ciphertext)).toBe(true);
        expect(now?.nonce.equals(rewrapped.nonce)).toBe(true);
    });
});
