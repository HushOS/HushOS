import { readFileSync } from 'node:fs';
// The group core's own builder, test-only: the server never imports the client's.
import {
    successionConsentStatement as coreConsentStatement,
    type SuccessionStatement as CoreLink,
} from '../../crypto/src/signatures';
import { verifySuccessionConsent as coreConsentHolds } from '../../crypto/src/identity';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { bytes, freshV2, registered, seedOf, signedIn } from '../test/accounts';
import {
    closeDatabase,
    hybridSignerFromSeed,
    resetDatabase,
    type HybridSigner,
} from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountIdentities,
    accountIdentityHistory,
    opaqueCredentials,
    sessions,
    users,
} from './schema';
import {
    successionConsentHolds,
    successionConsentStatement,
    successionStatement,
    type SuccessionStatementInput,
} from './signatures';

/*
 * The successor's consent (F8, docs/groups-server.md 5): two hybrid
 * signatures over the consent statement, the old identity's as "old" and the
 * new identity's as "new". The group core asks it of links from a member's
 * first keys, so a consent the server stores that does not hold would be served
 * as though it did; one it drops would leave a member's earlier keys
 * unretired. Optional on upload in 1b, checked whenever sent.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

/* A registered account whose version 2 identity signs for real, at key version 1, signed in. */
async function account(label: string) {
    const { user, workspaceId } = await registered(`${label}@hushos.test`);
    const signer = hybridSignerFromSeed(seedOf(`old:${label}`));
    await db
        .update(accountIdentities)
        .set(freshV2(user.id, signer, 1))
        .where(eq(accountIdentities.userId, user.id));
    return { user, workspaceId, signer, sessionTokenHash: await signedIn(user.id) };
}

/* The next identity, the link it makes, the old keys' version 2 signature and a consent that holds. */
async function successor(userId: string, signer: HybridSigner, label: string) {
    const current = (await auth.getIdentity(userId))!;
    const next = hybridSignerFromSeed(seedOf(`new:${label}`));
    const identity = freshV2(userId, next, current.keyVersion + 1);
    const link: SuccessionStatementInput = {
        userId,
        oldKeyVersion: current.keyVersion,
        newKeyVersion: identity.keyVersion,
        oldEncryptionPublicKey: current.encryptionPublicKey,
        oldSigningPublicKey: current.signingPublicKey,
        oldMlDsaPublicKey: current.mlDsaPublicKey!,
        newEncryptionPublicKey: identity.encryptionPublicKey,
        newSigningPublicKey: identity.signingPublicKey,
        newMlDsaPublicKey: identity.mlDsaPublicKey,
        newKemPublicKey: identity.kemPublicKey,
    };
    const oldHalf = signer.sign(successionConsentStatement(link, 'old'));
    const newHalf = next.sign(successionConsentStatement(link, 'new'));
    return {
        identity,
        next,
        link,
        oldHalf,
        newHalf,
        signature: signer.sign(successionStatement(link)),
        consent: Buffer.concat([oldHalf, newHalf]),
    };
}

const flip = (value: Buffer, at: number) => {
    const copy = Buffer.from(value);
    copy[at] = copy[at]! ^ 0x01;
    return copy;
};

describe('successor consent on an identity succession', () => {
    test('is stored when both halves hold, and served with the link and in the history', async () => {
        const { user, signer, sessionTokenHash } = await account('consent-ok');
        const made = await successor(user.id, signer, 'consent-ok');
        expect(made.consent).toHaveLength(6746);
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity: made.identity,
                signature: made.signature,
                consent: made.consent,
            }),
        ).toEqual({ status: 'ok', keyVersion: 2 });
        const [link] = (await auth.successionChain(user.id, 1))!;
        expect(link!.consent!.equals(made.consent)).toBe(true);
        expect(link!.signature.equals(made.signature)).toBe(true);
        const [history] = await auth.listIdentityHistory(user.id);
        expect(history!.successionConsent!.equals(made.consent)).toBe(true);
    });

    test('is optional in 1b: a link without it is taken and served with none', async () => {
        const { user, signer, sessionTokenHash } = await account('consent-none');
        const made = await successor(user.id, signer, 'consent-none');
        expect(
            await auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity: made.identity,
                signature: made.signature,
            }),
        ).toEqual({ status: 'ok', keyVersion: 2 });
        const [link] = (await auth.successionChain(user.id, 1))!;
        expect(link!.consent).toBeNull();
    });

    test('is refused, and nothing is stored, unless each half holds under its own keys in its own role', async () => {
        const { user, signer, sessionTokenHash } = await account('consent-bad');
        const made = await successor(user.id, signer, 'consent-bad');
        const attempt = (consent: Buffer) =>
            auth.succeedIdentity({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                identity: made.identity,
                signature: made.signature,
                consent,
            });
        // Another successor's consent: a genuine pair, for a link to other new keys.
        const elsewhere = await successor(user.id, signer, 'consent-bad-elsewhere');
        // The same keys consenting to the same link for another account.
        const otherAccount = { ...made.link, userId: '22222222-2222-4222-8222-222222222222' };
        const otherAccountConsent = Buffer.concat([
            signer.sign(successionConsentStatement(otherAccount, 'old')),
            made.next.sign(successionConsentStatement(otherAccount, 'new')),
        ]);
        const refused: [string, Buffer][] = [
            ['a byte flipped in the old half (Ed25519)', flip(made.consent, 10)],
            ['a byte flipped in the old half (ML-DSA)', flip(made.consent, 1000)],
            ['a byte flipped in the new half (Ed25519)', flip(made.consent, 3373 + 10)],
            ['a byte flipped in the new half (ML-DSA)', flip(made.consent, 3373 + 1000)],
            ['the halves swapped', Buffer.concat([made.newHalf, made.oldHalf])],
            // The planter's case: the old keys alone, in both roles, are not the successor.
            [
                'the old keys in both roles',
                Buffer.concat([
                    made.oldHalf,
                    signer.sign(successionConsentStatement(made.link, 'new')),
                ]),
            ],
            [
                'the new keys in both roles',
                Buffer.concat([
                    made.next.sign(successionConsentStatement(made.link, 'old')),
                    made.newHalf,
                ]),
            ],
            ['the version 2 signature, doubled', Buffer.concat([made.signature, made.signature])],
            [
                'the version 2 signature beside the new half',
                Buffer.concat([made.signature, made.newHalf]),
            ],
            ["another link's consent", elsewhere.consent],
            ["another account's consent", otherAccountConsent],
            ['one byte short', made.consent.subarray(0, 6745)],
        ];
        for (const [, consent] of refused)
            expect(await attempt(consent)).toEqual({ status: 'bad-signature' });
        expect((await auth.getIdentity(user.id))!.keyVersion).toBe(1);
        expect(await auth.listIdentityHistory(user.id)).toEqual([]);
        // The genuine consent still lands afterwards.
        expect(await attempt(made.consent)).toEqual({ status: 'ok', keyVersion: 2 });
    });

    test('a master-key rotation re-wraps the history row and leaves its consent byte for byte', async () => {
        const { user, workspaceId, signer, sessionTokenHash } = await account('consent-rewrap');
        const made = await successor(user.id, signer, 'consent-rewrap');
        await auth.succeedIdentity({
            userId: user.id,
            credentialVersion: 1,
            sessionTokenHash,
            identity: made.identity,
            signature: made.signature,
            consent: made.consent,
        });
        const current = (await auth.getIdentity(user.id))!;
        const [old] = await auth.listIdentityHistory(user.id);
        const rewrap = (row: typeof current | NonNullable<typeof old>) => ({
            version: row.version,
            keyVersion: row.keyVersion,
            wrappingSalt: bytes(32),
            encryptionPublicKey: row.encryptionPublicKey,
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: row.signingPublicKey,
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
            kemPublicKey: row.kemPublicKey,
            kemSeedNonce: bytes(24),
            encryptedKemSeed: bytes(80),
            kemSignature: row.kemSignature,
            mlDsaPublicKey: row.mlDsaPublicKey,
            mlDsaSeedNonce: bytes(24),
            encryptedMlDsaSeed: bytes(48),
            keysSignature: row.keysSignature,
        });
        const history = rewrap(old!);
        expect(
            await auth.changeAccountSecurity({
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
                identity: rewrap(current),
                identityHistory: [history],
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
            }),
        ).toBe(true);
        const [after] = await auth.listIdentityHistory(user.id);
        // The rotation did run on this row: its wrapped seed is the new one.
        expect(after!.encryptedMlDsaSeed!.equals(history.encryptedMlDsaSeed)).toBe(true);
        expect(after!.successionConsent!.equals(made.consent)).toBe(true);
        expect(after!.successionSignature.equals(made.signature)).toBe(true);
    });
});

/*
 * Consent for a succession made before clients sent it (docs/groups-server.md
 * 5, the backfill route): checked as /succession checks it, under the keys
 * the stored link names, and stored only where the link has none. A forged
 * consent stored here would be served to every group member as though it
 * held; one written over an existing consent would let any device that can
 * sign for the account replace what the account's history says.
 */
describe('consent for an earlier succession', () => {
    /* An account whose succession from key version 1 landed without consent. */
    async function consentless(label: string) {
        const made = await account(label);
        const link = await successor(made.user.id, made.signer, label);
        expect(
            await auth.succeedIdentity({
                userId: made.user.id,
                credentialVersion: 1,
                sessionTokenHash: made.sessionTokenHash,
                identity: link.identity,
                signature: link.signature,
            }),
        ).toEqual({ status: 'ok', keyVersion: 2 });
        const backfill = (
            consent: Buffer,
            oldKeyVersion = 1,
            sessionTokenHash = made.sessionTokenHash,
        ) =>
            auth.backfillSuccessionConsent({
                userId: made.user.id,
                credentialVersion: 1,
                sessionTokenHash,
                oldKeyVersion,
                consent,
            });
        const stored = async () => (await auth.successionChain(made.user.id, 1))![0]!.consent;
        return { ...made, ...link, backfill, stored };
    }

    test('is stored once it holds, and a forged one is refused with nothing stored', async () => {
        const mine = await consentless('backfill-forged');
        // The same keys consenting to the same link for another account.
        const otherAccount = { ...mine.link, userId: '22222222-2222-4222-8222-222222222222' };
        const refused: [string, Buffer][] = [
            ['a byte flipped in the old half', flip(mine.consent, 1000)],
            ['a byte flipped in the new half', flip(mine.consent, 3373 + 1000)],
            ['the halves swapped', Buffer.concat([mine.newHalf, mine.oldHalf])],
            [
                'the old keys in both roles',
                Buffer.concat([
                    mine.oldHalf,
                    mine.signer.sign(successionConsentStatement(mine.link, 'new')),
                ]),
            ],
            ['the version 2 signature, doubled', Buffer.concat([mine.signature, mine.signature])],
            [
                "another account's consent",
                Buffer.concat([
                    mine.signer.sign(successionConsentStatement(otherAccount, 'old')),
                    mine.next.sign(successionConsentStatement(otherAccount, 'new')),
                ]),
            ],
        ];
        for (const [, consent] of refused)
            expect(await mine.backfill(consent)).toEqual({ status: 'bad-signature' });
        expect(await mine.stored()).toBeNull();
        // Only a current session uploads it.
        expect(await mine.backfill(mine.consent, 1, Buffer.alloc(32))).toEqual({
            status: 'session',
        });
        // Only for a link the account has: its current keys replaced nothing yet.
        expect(await mine.backfill(mine.consent, 2)).toEqual({ status: 'no-link' });
        expect(await mine.stored()).toBeNull();
        expect(await mine.backfill(mine.consent)).toEqual({ status: 'ok', stored: true });
        expect((await mine.stored())!.equals(mine.consent)).toBe(true);
        // A forged one after it is still refused, not answered as already stored.
        expect(await mine.backfill(flip(mine.consent, 10))).toEqual({ status: 'bad-signature' });
    });

    test('never replaces a consent that is stored, and answers a repeat as not stored', async () => {
        const mine = await consentless('backfill-kept');
        expect(await mine.backfill(mine.consent)).toEqual({ status: 'ok', stored: true });
        expect(await mine.backfill(mine.consent)).toEqual({ status: 'ok', stored: false });
        // Whatever is stored stays, even when the upload holds and differs from it.
        const earlier = bytes(6746);
        await db
            .update(accountIdentityHistory)
            .set({ successionConsent: earlier })
            .where(eq(accountIdentityHistory.userId, mine.user.id));
        expect(await mine.backfill(mine.consent)).toEqual({ status: 'ok', stored: false });
        expect((await mine.stored())!.equals(earlier)).toBe(true);
    });

    test('a link from a version 1 identity has no ML-DSA keys to consent with', async () => {
        // Registered with a version 1 identity, replaced before hybrid signatures existed.
        const { user } = await registered('backfill-v1@hushos.test');
        const sessionTokenHash = await signedIn(user.id);
        const current = (await auth.getIdentity(user.id))!;
        expect(current.version).toBe(1);
        const { userId: _userId, ...old } = current;
        await db.insert(accountIdentityHistory).values({
            ...old,
            userId: user.id,
            replacedByKeyVersion: 2,
            newEncryptionPublicKey: bytes(32),
            newSigningPublicKey: bytes(32),
            newKemPublicKey: bytes(1184),
            successionSignature: bytes(64),
        });
        expect(
            await auth.backfillSuccessionConsent({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash,
                oldKeyVersion: 1,
                consent: bytes(6746),
            }),
        ).toEqual({ status: 'not-upgraded' });
        expect((await auth.successionChain(user.id, 1))![0]!.consent).toBeNull();
    });

    test("touches only the uploader's own history, whoever's consent it carries", async () => {
        const mine = await consentless('backfill-mine');
        const theirs = await consentless('backfill-theirs');
        // Their genuine consent, uploaded from my session, is checked against my link: refused.
        expect(await mine.backfill(theirs.consent)).toEqual({ status: 'bad-signature' });
        expect(await mine.stored()).toBeNull();
        expect(await theirs.stored()).toBeNull();
        expect(await mine.backfill(mine.consent)).toEqual({ status: 'ok', stored: true });
        expect(await theirs.stored()).toBeNull();
        expect(await theirs.backfill(theirs.consent)).toEqual({ status: 'ok', stored: true });
        expect((await mine.stored())!.equals(mine.consent)).toBe(true);
        expect((await theirs.stored())!.equals(theirs.consent)).toBe(true);
    });
});

/*
 * The server builds the consent statement itself (signatures.ts never imports
 * the client's), so the two must agree byte for byte or every consent a client
 * makes is refused. Pinned against the group core's own fixtures: every link
 * with consent in crates/hushos-core/fixtures/web-groups.json (which both
 * twins verify), the statements the core's successionConsentStatement builds
 * for each, and the consent the core made over them.
 */
describe('the consent statement', () => {
    type Link = Record<string, string | number | null>;
    const fixtures = JSON.parse(
        readFileSync(
            new URL('../../../crates/hushos-core/fixtures/web-groups.json', import.meta.url),
            'utf8',
        ),
    ) as { cases: { input?: { record?: { writerUserId?: string; links?: Link[] } } }[] };
    const consented = fixtures.cases.flatMap((entry) =>
        (entry.input?.record?.links ?? [])
            .filter((link) => typeof link.consent === 'string')
            .map((link) => ({ userId: entry.input!.record!.writerUserId!, link })),
    );
    const inputOf = (userId: string, link: Link): SuccessionStatementInput => {
        const b = (field: string) => Buffer.from(link[field] as string, 'base64url');
        return {
            userId,
            oldKeyVersion: link.oldKeyVersion as number,
            newKeyVersion: link.newKeyVersion as number,
            oldEncryptionPublicKey: b('oldEncryptionPublicKey'),
            oldSigningPublicKey: b('oldSigningPublicKey'),
            oldMlDsaPublicKey: b('oldMlDsaPublicKey'),
            newEncryptionPublicKey: b('newEncryptionPublicKey'),
            newSigningPublicKey: b('newSigningPublicKey'),
            newMlDsaPublicKey: b('newMlDsaPublicKey'),
            newKemPublicKey: b('newKemPublicKey'),
        };
    };

    test('is the bytes the group core builds, in both roles, for every consented link in its fixtures', async () => {
        // Fewer than this and the fixtures no longer carry what this pins.
        expect(consented.length).toBeGreaterThan(10);
        let built = 0;
        for (const { userId, link } of consented) {
            const fields = {
                userId,
                ...(Object.fromEntries(
                    Object.entries(link).filter(
                        ([key]) => key !== 'signature' && key !== 'consent',
                    ),
                ) as Omit<CoreLink, 'userId'>),
            };
            for (const role of ['old', 'new'] as const) {
                // Some fixture links carry keys the core itself refuses to build over: skipped.
                const core = await coreConsentStatement(fields, role).catch(() => null);
                if (!core) continue;
                built++;
                expect(successionConsentStatement(inputOf(userId, link), role)).toEqual(
                    Buffer.from(core),
                );
            }
        }
        expect(built).toBeGreaterThan(10);
    });

    test("the server's check agrees with the core's on every consented link, forged ones included", async () => {
        let held = 0;
        for (const { userId, link } of consented) {
            const core = await coreConsentHolds(userId, link as never);
            let server = false;
            try {
                server = successionConsentHolds(
                    inputOf(userId, link),
                    Buffer.from(link.consent as string, 'base64url'),
                );
            } catch {
                server = false;
            }
            expect(server).toBe(core);
            if (core) held++;
        }
        // Both answers occur (the fixtures carry forged consents too): agreement on both sides.
        expect(held).toBeGreaterThan(0);
        expect(held).toBeLessThan(consented.length);
        const genuine = consented.find(({ userId, link }) => {
            try {
                return successionConsentHolds(
                    inputOf(userId, link),
                    Buffer.from(link.consent as string, 'base64url'),
                );
            } catch {
                return false;
            }
        })!;
        const consent = Buffer.from(genuine.link.consent as string, 'base64url');
        expect(
            successionConsentHolds(
                inputOf('00000009-abcd-4abc-8abc-abcdefabcdef', genuine.link),
                consent,
            ),
        ).toBe(false);
        expect(
            successionConsentHolds(
                { ...inputOf(genuine.userId, genuine.link), newKeyVersion: 99 },
                consent,
            ),
        ).toBe(false);
        expect(
            successionConsentHolds(inputOf(genuine.userId, genuine.link), flip(consent, 6745)),
        ).toBe(false);
    });
});

/*
 * Consent the Rust core signed for an earlier link (the phones' backfill,
 * succession_consent_sign; crates/hushos-core/examples/join_fixtures.rs):
 * the server must store it as it stores the web's, or every phone's backfill
 * upload is refused. The account is the fixture's own (its user id is in
 * every statement), its history rows the core's identities and links, so the
 * statement the server builds is checked against signatures no web code made.
 */
describe('consent the native core signed', () => {
    type Envelope = {
        version: number;
        keyVersion: number;
        wrappingSalt: string;
        encryptionPublicKey: string;
        encryptionPrivateKeyNonce: string;
        encryptedEncryptionPrivateKey: string;
        signingPublicKey: string;
        signingSeedNonce: string;
        encryptedSigningSeed: string;
        kem: { publicKey: string; seedNonce: string; encryptedSeed: string };
        mlDsa: { publicKey: string; seedNonce: string; encryptedSeed: string };
        keysSignature: string;
    };
    type SignCase = {
        name: string;
        old: string;
        next: string;
        outcome: { status: string; consent?: string };
    };
    const { consents } = JSON.parse(
        readFileSync(
            new URL('../../crypto/src/__fixtures__/core-join.json', import.meta.url),
            'utf8',
        ),
    ) as {
        consents: {
            userId: string;
            identities: Record<string, Envelope>;
            links: Record<string, { signature: string }>;
            signs: SignCase[];
        };
    };
    const b = (text: string) => Buffer.from(text, 'base64url');
    const linkOf = (c: SignCase, userId = consents.userId): SuccessionStatementInput => {
        const old = consents.identities[c.old]!;
        const next = consents.identities[c.next]!;
        return {
            userId,
            oldKeyVersion: old.keyVersion,
            newKeyVersion: next.keyVersion,
            oldEncryptionPublicKey: b(old.encryptionPublicKey),
            oldSigningPublicKey: b(old.signingPublicKey),
            oldMlDsaPublicKey: b(old.mlDsa.publicKey),
            newEncryptionPublicKey: b(next.encryptionPublicKey),
            newSigningPublicKey: b(next.signingPublicKey),
            newMlDsaPublicKey: b(next.mlDsa.publicKey),
            newKemPublicKey: b(next.kem.publicKey),
        };
    };
    /* The history row of `old`, replaced by `next` through `link`, as /succession stored it, without consent. */
    const historyRow = (old: Envelope, next: Envelope, signature: string) => ({
        userId: consents.userId,
        version: 2,
        keyVersion: old.keyVersion,
        wrappingSalt: b(old.wrappingSalt),
        encryptionPublicKey: b(old.encryptionPublicKey),
        encryptionPrivateKeyNonce: b(old.encryptionPrivateKeyNonce),
        encryptedEncryptionPrivateKey: b(old.encryptedEncryptionPrivateKey),
        signingPublicKey: b(old.signingPublicKey),
        signingSeedNonce: b(old.signingSeedNonce),
        encryptedSigningSeed: b(old.encryptedSigningSeed),
        kemPublicKey: b(old.kem.publicKey),
        kemSeedNonce: b(old.kem.seedNonce),
        encryptedKemSeed: b(old.kem.encryptedSeed),
        kemSignature: null,
        mlDsaPublicKey: b(old.mlDsa.publicKey),
        mlDsaSeedNonce: b(old.mlDsa.seedNonce),
        encryptedMlDsaSeed: b(old.mlDsa.encryptedSeed),
        keysSignature: b(old.keysSignature),
        createdAt: new Date(),
        replacedByKeyVersion: next.keyVersion,
        newEncryptionPublicKey: b(next.encryptionPublicKey),
        newSigningPublicKey: b(next.signingPublicKey),
        newKemPublicKey: b(next.kem.publicKey),
        newMlDsaPublicKey: b(next.mlDsa.publicKey),
        successionSignature: b(signature),
    });

    test('is stored by the backfill for its own link, and refused for any other', async () => {
        const userId = consents.userId;
        const email = 'core-consent@hushos.test';
        await db.insert(users).values({
            id: userId,
            name: 'Core',
            email,
            normalizedEmail: email,
            emailVerifiedAt: new Date(),
        });
        await db.insert(opaqueCredentials).values({
            userId,
            registrationRecord: 'record',
            profileVersion: 1,
            serverSetupId: 'primary',
        });
        const { a, b: second, c } = consents.identities as Record<string, Envelope>;
        await db
            .insert(accountIdentityHistory)
            .values([
                historyRow(a!, second!, consents.links.ab!.signature),
                historyRow(second!, c!, consents.links.bc!.signature),
            ]);
        // A current session, as backfillSuccessionConsent checks one: the row itself (the account
        // has no key rows to sign in through, and the backfill reads none).
        const sessionTokenHash = bytes(32);
        await db.insert(sessions).values({
            userId,
            tokenHash: sessionTokenHash,
            credentialVersion: 1,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const backfill = (oldKeyVersion: number, consent: Buffer) =>
            auth.backfillSuccessionConsent({
                userId,
                credentialVersion: 1,
                sessionTokenHash,
                oldKeyVersion,
                consent,
            });
        const signed = consents.signs.filter((k) => k.outcome.status === 'signed');
        expect(signed.map((k) => [k.old, k.next])).toEqual([
            ['a', 'b'],
            ['b', 'c'],
        ]);
        const [ab, bc] = signed.map((k) => b(k.outcome.consent!)) as [Buffer, Buffer];
        expect(ab).toHaveLength(6746);
        // Each consent holds for its own link and account only.
        expect(successionConsentHolds(linkOf(signed[0]!), ab)).toBe(true);
        expect(
            successionConsentHolds(linkOf(signed[0]!, '22222222-2222-4222-8222-222222222222'), ab),
        ).toBe(false);
        // Refused before anything is stored: a byte flipped, the halves swapped, another link's.
        expect(await backfill(1, flip(ab, 3373 + 1000))).toEqual({ status: 'bad-signature' });
        expect(await backfill(1, Buffer.concat([ab.subarray(3373), ab.subarray(0, 3373)]))).toEqual(
            { status: 'bad-signature' },
        );
        expect(await backfill(1, bc)).toEqual({ status: 'bad-signature' });
        expect(await backfill(2, ab)).toEqual({ status: 'bad-signature' });
        // Stored, each at its own key version, and served with its link.
        expect(await backfill(1, ab)).toEqual({ status: 'ok', stored: true });
        expect(await backfill(2, bc)).toEqual({ status: 'ok', stored: true });
        const rows = await db
            .select({
                keyVersion: accountIdentityHistory.keyVersion,
                consent: accountIdentityHistory.successionConsent,
            })
            .from(accountIdentityHistory)
            .where(eq(accountIdentityHistory.userId, userId))
            .orderBy(accountIdentityHistory.keyVersion);
        expect(
            rows.map((row) => [
                row.keyVersion,
                row.consent?.equals(row.keyVersion === 1 ? ab : bc),
            ]),
        ).toEqual([
            [1, true],
            [2, true],
        ]);
        // A stored consent is never replaced: the other one, even holding, stores nothing more.
        expect(await backfill(1, ab)).toEqual({ status: 'ok', stored: false });
    });
});
