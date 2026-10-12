import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, resetDatabase, signingKeyFromSeed } from '../test/helpers';
import { successionStatement } from './signatures';
import * as auth from './auth';
import { db } from './client';
import {
    accountEnrollments,
    accountIdentities,
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

describe('the identity’s KEM key', () => {
    const kem = () => ({
        kemPublicKey: bytes(1184),
        kemSeedNonce: bytes(24),
        encryptedKemSeed: bytes(80),
        kemSignature: bytes(64),
    });

    test('is absent at first, added exactly once, and served on lookup', async () => {
        const user = await registered('kem@hushos.test');
        expect((await auth.lookupIdentity('kem@hushos.test'))?.kemPublicKey).toBeNull();
        const first = kem();
        expect(await auth.addIdentityKem({ userId: user.id, ...first })).toBe(true);
        // A second device that raced to mint one is refused; the first key stands.
        expect(await auth.addIdentityKem({ userId: user.id, ...kem() })).toBe(false);
        const served = await auth.lookupIdentity('kem@hushos.test');
        expect(served?.kemPublicKey?.equals(first.kemPublicKey)).toBe(true);
        expect(served?.kemSignature?.equals(first.kemSignature)).toBe(true);
        // Half a key is refused by the table itself.
        await expect(
            db
                .update(accountIdentities)
                .set({ kemSignature: null })
                .where(eq(accountIdentities.userId, user.id)),
        ).rejects.toThrow();
    });

    test('survives a master-key rotation unchanged and cannot be swapped by one', async () => {
        const email = 'rotate@hushos.test';
        const workspaceId = randomUUID();
        const created = await auth.registerAccount({
            enrollmentTokenHash: await verifiedEnrollment(email),
            ...registration(workspaceId),
        });
        if (created.status !== 'created') throw new Error(created.status);
        const user = created.user;
        const minted = kem();
        await auth.addIdentityKem({ userId: user.id, ...minted });
        const sessionTokenHash = await signedIn(user.id);
        const stored = (await auth.getIdentity(user.id))!;
        const change = (kemPublicKey: Buffer | null) =>
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
                identity: {
                    keyVersion: 2,
                    wrappingSalt: bytes(32),
                    encryptionPublicKey: stored.encryptionPublicKey,
                    encryptionPrivateKeyNonce: bytes(24),
                    encryptedEncryptionPrivateKey: bytes(48),
                    signingPublicKey: stored.signingPublicKey,
                    signingSeedNonce: bytes(24),
                    encryptedSigningSeed: bytes(48),
                    kemPublicKey,
                    kemSeedNonce: kemPublicKey ? bytes(24) : null,
                    encryptedKemSeed: kemPublicKey ? bytes(80) : null,
                    kemSignature: kemPublicKey ? stored.kemSignature : null,
                },
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
        // A different KEM key in the rewrapped bundle is a swap, and dropping it is a downgrade.
        expect(await change(bytes(1184))).toBe(false);
        expect(await change(null)).toBe(false);
        // The same key, rewrapped under the new root, goes through.
        expect(await change(minted.kemPublicKey)).toBe(true);
        expect((await auth.getIdentity(user.id))?.kemPublicKey?.equals(minted.kemPublicKey)).toBe(
            true,
        );
    });
});

describe('identity succession', () => {
    const seed = (label: string) => createHash('sha256').update(label).digest();
    const kemKey = () => ({
        kemPublicKey: bytes(1184),
        kemSeedNonce: bytes(24),
        encryptedKemSeed: bytes(80),
        kemSignature: bytes(64),
    });
    /* A registered account whose identity signs for real, at key version 1 with a KEM key. */
    async function account(email: string) {
        const user = await registered(email);
        const key = signingKeyFromSeed(seed(`old:${email}`));
        await db
            .update(accountIdentities)
            .set({ signingPublicKey: key.publicKey, ...kemKey() })
            .where(eq(accountIdentities.userId, user.id));
        return { user, key, sessionTokenHash: await signedIn(user.id) };
    }
    /* A new identity at `keyVersion`, and the old key's signature over its succession statement. */
    async function successor(
        userId: string,
        signer: ReturnType<typeof signingKeyFromSeed>,
        keyVersion: number,
        label: string,
    ) {
        const current = (await auth.getIdentity(userId))!;
        const next = signingKeyFromSeed(seed(`new:${label}`));
        const identity = {
            keyVersion,
            wrappingSalt: bytes(32),
            encryptionPublicKey: bytes(32),
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: next.publicKey,
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
            ...kemKey(),
        };
        const statement = successionStatement({
            userId,
            oldKeyVersion: current.keyVersion,
            newKeyVersion: keyVersion,
            oldEncryptionPublicKey: current.encryptionPublicKey,
            oldSigningPublicKey: current.signingPublicKey,
            newEncryptionPublicKey: identity.encryptionPublicKey,
            newSigningPublicKey: identity.signingPublicKey,
            newKemPublicKey: identity.kemPublicKey,
        });
        return { identity, next, statement, signature: signer.sign(statement) };
    }

    test('replaces the identity and keeps the old one, still sealed, with its succession', async () => {
        const { user, key, sessionTokenHash } = await account('succeed@hushos.test');
        const before = (await auth.getIdentity(user.id))!;
        const { identity, signature } = await successor(user.id, key, 2, 'a');
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
        expect(now.signingPublicKey.equals(identity.signingPublicKey)).toBe(true);
        // Contacts look the account up under its new keys and version.
        const served = await auth.lookupIdentity('succeed@hushos.test');
        expect(served?.keyVersion).toBe(2);
        expect(served?.encryptionPublicKey.equals(identity.encryptionPublicKey)).toBe(true);
        // The old envelope, byte for byte, so the account's devices still open shares sealed to it.
        const [old] = await auth.listIdentityHistory(user.id);
        expect(old).toMatchObject({
            keyVersion: 1,
            replacedByKeyVersion: 2,
            createdAt: before.createdAt,
        });
        for (const field of [
            'wrappingSalt',
            'encryptionPublicKey',
            'encryptedEncryptionPrivateKey',
            'signingPublicKey',
            'encryptedSigningSeed',
            'kemPublicKey',
            'encryptedKemSeed',
            'kemSignature',
        ] as const)
            expect(old![field]?.equals(before[field]!)).toBe(true);
        expect(old!.successionSignature.equals(signature)).toBe(true);
    });

    test('refuses a key version other than the next one, and changes nothing', async () => {
        const { user, key, sessionTokenHash } = await account('version@hushos.test');
        for (const keyVersion of [1, 3]) {
            const { identity, signature } = await successor(user.id, key, keyVersion, 'v');
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

    test('refuses a statement not signed by the current key, or not the one stored', async () => {
        const { user, key, sessionTokenHash } = await account('forged@hushos.test');
        // Signed by the new key: anyone holding only the new identity could make that.
        const selfSigned = await successor(user.id, key, 2, 'b');
        const attempt = (
            identity: Parameters<typeof auth.succeedIdentity>[0]['identity'],
            signature: Buffer,
        ): ReturnType<typeof auth.succeedIdentity> =>
            auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity,
                signature,
            });
        expect(
            await attempt(selfSigned.identity, selfSigned.next.sign(selfSigned.statement)),
        ).toEqual({ status: 'bad-signature' });
        // A genuine signature, but the server is handed a different KEM key than the one signed.
        expect(
            await attempt(
                { ...selfSigned.identity, kemPublicKey: bytes(1184) },
                selfSigned.signature,
            ),
        ).toEqual({ status: 'bad-signature' });
        // The same keys again are not a succession.
        const current = (await auth.getIdentity(user.id))!;
        expect(
            await attempt(
                { ...selfSigned.identity, signingPublicKey: current.signingPublicKey },
                selfSigned.signature,
            ),
        ).toEqual({ status: 'unchanged' });
        expect((await auth.getIdentity(user.id))?.keyVersion).toBe(1);
    });

    test('refuses a session that a rotation or sign-out has ended', async () => {
        const { user, key } = await account('ended@hushos.test');
        const { identity, signature } = await successor(user.id, key, 2, 'c');
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: hash('no such session'),
                identity,
                signature,
            }),
        ).toEqual({ status: 'session' });
    });

    test('the chain lists each succession in order from the version asked for', async () => {
        const { user, key, sessionTokenHash } = await account('chain@hushos.test');
        const first = await successor(user.id, key, 2, 'chain-1');
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
        expect(chain![0]!.newSigningPublicKey.equals(first.identity.signingPublicKey)).toBe(true);
        expect(chain![1]!.oldSigningPublicKey.equals(first.identity.signingPublicKey)).toBe(true);
        expect(chain![1]!.newKemPublicKey.equals(second.identity.kemPublicKey)).toBe(true);
        expect(chain![1]!.signature.equals(second.signature)).toBe(true);
        expect((await auth.successionChain(user.id, 2))?.map((l) => l.oldKeyVersion)).toEqual([2]);
        expect(await auth.successionChain(user.id, 3)).toEqual([]);
        expect(await auth.successionChain(randomUUID(), 1)).toBeNull();
    });

    test('a master-key rotation re-wraps every earlier identity and never lowers the key version', async () => {
        const workspaceId = randomUUID();
        const created = await auth.registerAccount({
            enrollmentTokenHash: await verifiedEnrollment('rewrap@hushos.test'),
            ...registration(workspaceId),
        });
        if (created.status !== 'created') throw new Error(created.status);
        const user = created.user;
        const key = signingKeyFromSeed(seed('old:rewrap'));
        await db
            .update(accountIdentities)
            .set({ signingPublicKey: key.publicKey, ...kemKey() })
            .where(eq(accountIdentities.userId, user.id));
        const sessionTokenHash = await signedIn(user.id);
        const succession = await successor(user.id, key, 2, 'rewrap');
        await auth.succeedIdentity({
            userId: user.id,
            credentialVersion: 1,
            sessionTokenHash,
            ...succession,
        });
        const current = (await auth.getIdentity(user.id))!;
        const [old] = await auth.listIdentityHistory(user.id);
        const rewrap = <T extends typeof current | typeof old>(row: T, keyVersion: number) => ({
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
        });
        // The account root is at version 1 and goes to 2; the identity is already at 2.
        const change = (
            identityVersion: number,
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
                identity: rewrap(current, identityVersion),
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
        // Left behind under the old root, the earlier identity would be lost with it.
        expect(await change(2, undefined)).toBe(false);
        // A history entry that changes the old public keys is not a re-wrap.
        expect(await change(2, [{ ...rewrap(old, 1), signingPublicKey: bytes(32) }])).toBe(false);
        // Back to version 1 would reuse the version the history and contacts' pins name.
        expect(await change(1, [rewrap(old, 1)])).toBe(false);
        const history = rewrap(old, 1);
        expect(await change(2, [history])).toBe(true);
        const [after] = await auth.listIdentityHistory(user.id);
        expect(after!.encryptedSigningSeed.equals(history.encryptedSigningSeed)).toBe(true);
        expect(after!.signingPublicKey.equals(old!.signingPublicKey)).toBe(true);
        expect(after!.successionSignature.equals(old!.successionSignature)).toBe(true);
        expect((await auth.getIdentity(user.id))?.keyVersion).toBe(2);
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
