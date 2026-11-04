import { beforeAll, describe, expect, test } from 'vitest';
import { firstSeenOfLegacy, guardAgrees, nextGuardEntry, type GuardEntry } from './first-seen';
import {
    createIdentity,
    createSuccessor,
    openIdentityMlDsaKey,
    openIdentitySigningKey,
    publicIdentity,
    verifySuccessionChain,
    type IdentityEnvelopeV2,
    type SuccessionLink,
} from './identity';
import { keyCommitment, pinKeysOfServed, pinTrust, pinVerified } from './pins';
import { keysStatement, signHybrid, successionStatement } from './signatures';
import { decode, encode } from './keys';

/*
 * First-seen pins and the device's guard (docs/optional-verification.md 2.5,
 * 2.8). Every case is one a server that keeps the settings could try: carry a
 * legacy pin into trust on keys the person never pinned, replay an older or
 * forked copy of the settings over the one a device acted on, or hand a
 * device a succession that starts from keys it never held.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

type Identity = IdentityEnvelopeV2;
let root: Uint8Array<ArrayBuffer>;
/* One account's identities: K0 → K1 → K2 along signed successions; K3 a sideways one, K4 its successor. */
let K0: Identity, K1: Identity, K2: Identity, K3: Identity, K4: Identity;
let links: { k0k1: SuccessionLink; k1k2: SuccessionLink; k3k4: SuccessionLink };

async function keysOf(identity: Identity) {
    return {
        signingKey: await openIdentitySigningKey(root, USER, identity),
        mlDsaSecretKey: (await openIdentityMlDsaKey(root, USER, identity))!.secretKey,
    };
}
function linkOf(old: Identity, next: Identity, signature: string): SuccessionLink {
    return {
        oldKeyVersion: old.keyVersion,
        newKeyVersion: next.keyVersion,
        oldEncryptionPublicKey: old.encryptionPublicKey,
        oldSigningPublicKey: old.signingPublicKey,
        oldMlDsaPublicKey: old.mlDsa.publicKey,
        newEncryptionPublicKey: next.encryptionPublicKey,
        newSigningPublicKey: next.signingPublicKey,
        newMlDsaPublicKey: next.mlDsa.publicKey,
        newKemPublicKey: next.kem.publicKey,
        signature,
    };
}
async function successor(old: Identity) {
    const made = await createSuccessor(root, USER, old, await keysOf(old));
    return {
        identity: made.identity as Identity,
        link: linkOf(old, made.identity as Identity, made.signature),
    };
}
function servedOf(identity: Identity) {
    const { keysSignature: _, ...keys } = publicIdentity(identity);
    return keys;
}
/* The settings pin of an identity, first-seen unless said otherwise. */
async function pinOf(identity: Identity, form: 'seen' | 'verified' = 'seen', extra: object = {}) {
    return {
        userId: USER,
        email: 'maya@example.com',
        name: 'Maya',
        pinnedAt: '2026-10-26T10:00:00.000Z',
        ...(await pinKeysOfServed(servedOf(identity), form)),
        ...extra,
    };
}
/* This device's guard after it acted on an identity's pin. */
async function guardOf(identity: Identity, previous: GuardEntry | null = null) {
    return nextGuardEntry(previous, await pinOf(identity));
}

beforeAll(async () => {
    root = crypto.getRandomValues(new Uint8Array(32));
    K0 = (await createIdentity(root, USER)) as Identity;
    const one = await successor(K0);
    K1 = one.identity;
    const two = await successor(K1);
    K2 = two.identity;
    K3 = (await createIdentity(root, USER, 2)) as Identity;
    const four = await successor(K3);
    K4 = four.identity;
    links = { k0k1: one.link, k1k2: two.link, k3k4: four.link };
});

describe('a legacy pin', () => {
    /* A pin from before post-quantum identities: X25519 and Ed25519, the version 2 fingerprint. */
    const legacyOf = (identity: Identity) => ({
        userId: USER,
        email: 'maya@example.com',
        name: 'Maya',
        pinnedAt: '2025-01-01T00:00:00.000Z',
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        fingerprint: '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000',
    });

    test('becomes first-seen over the served keys when its classical keys are served and the keys statement holds', async () => {
        const legacy = legacyOf(K0);
        expect(await pinTrust(legacy)).toBe('legacy');
        const upgraded = await firstSeenOfLegacy(USER, legacy, publicIdentity(K0));
        expect(upgraded).not.toBeNull();
        expect(await pinTrust(upgraded!)).toBe('seen');
        expect(await pinVerified(upgraded!)).toBe(false);
        expect(upgraded).toMatchObject({
            email: 'maya@example.com',
            pinnedAt: legacy.pinnedAt,
            fingerprint: '',
        });
        expect(await keyCommitment(upgraded!)).toBe(
            await keyCommitment(await pinOf(K0, 'verified')),
        );
        // A malformed version 3 pin over the same classical keys may become first-seen too.
        const invalid = { ...(await pinOf(K0)), fingerprint: 'not a fingerprint' };
        expect(await pinTrust(invalid)).toBe('invalid');
        expect(await pinTrust((await firstSeenOfLegacy(USER, invalid, publicIdentity(K0)))!)).toBe(
            'seen',
        );
    });

    test('stays legacy when the keys statement is signed by another Ed25519 key, or names other classical keys', async () => {
        const legacy = legacyOf(K0);
        // The pinned X25519 and Ed25519 keys beside lattice keys of the server's, with a keys
        // statement over them signed by another Ed25519 key (and the server's own ML-DSA key).
        const planted = K3;
        const forged = {
            keyVersion: K0.keyVersion,
            encryptionPublicKey: K0.encryptionPublicKey,
            signingPublicKey: K0.signingPublicKey,
            mlDsaPublicKey: planted.mlDsa.publicKey,
            kemPublicKey: planted.kem.publicKey,
        };
        const keysSignature = encode(
            await signHybrid(
                await keysStatement({ ...forged, userId: USER }),
                await keysOf(planted),
            ),
        );
        expect(await firstSeenOfLegacy(USER, legacy, { ...forged, keysSignature })).toBeNull();
        // The real statement presented for another account, or another identity's statement.
        expect(await firstSeenOfLegacy(OTHER, legacy, publicIdentity(K0))).toBeNull();
        expect(
            await firstSeenOfLegacy(USER, legacy, {
                ...publicIdentity(K0),
                keysSignature: publicIdentity(K3).keysSignature,
            }),
        ).toBeNull();
        // Another identity whose statement holds, but other classical keys than the pin's.
        expect(await firstSeenOfLegacy(USER, legacy, publicIdentity(K3))).toBeNull();
        expect(
            await firstSeenOfLegacy(
                USER,
                { ...legacy, signingPublicKey: K3.signingPublicKey },
                publicIdentity(K0),
            ),
        ).toBeNull();
    });

    test('a verified or first-seen pin is left as it is', async () => {
        expect(
            await firstSeenOfLegacy(USER, await pinOf(K0, 'verified'), publicIdentity(K0)),
        ).toBeNull();
        expect(await firstSeenOfLegacy(USER, await pinOf(K0), publicIdentity(K0))).toBeNull();
    });
});

describe('the guard', () => {
    test('with no entry it is first use; an entry that could not be read is never first use', async () => {
        expect(await guardAgrees(USER, null, await pinOf(K0))).toBe('first-use');
        expect(await guardAgrees(USER, null, null)).toBe('first-use');
        expect(await guardAgrees(USER, 'unreadable', await pinOf(K0))).toBe('unchecked');
        expect(await guardAgrees(USER, 'unreadable', null)).toBe('unchecked');
    });

    test('a newer copy carrying a stale verified pin of K1 while the guard holds K2 pauses', async () => {
        const guard = await guardOf(K2);
        const stale = await pinOf(K1, 'verified');
        expect(await pinVerified(stale)).toBe(true);
        expect(await guardAgrees(USER, guard, stale)).toBe('changed');
        // Not even with the served keys and links that lead to it from somewhere else.
        expect(
            await guardAgrees(USER, guard, stale, {
                served: servedOf(K1),
                links: [links.k0k1],
            }),
        ).toBe('changed');
        // The pin the guard holds, verified or first-seen, agrees.
        expect(await guardAgrees(USER, guard, await pinOf(K2, 'verified'))).toBe('agrees');
        expect(await guardAgrees(USER, guard, await pinOf(K2))).toBe('agrees');
    });

    test('a copy that drops the pin pauses at the next share rather than starting over', async () => {
        const guard = await guardOf(K0);
        // The settings no longer hold Maya: the Contacts list, which reads the settings, follows;
        // the guard still holds her, so this is the changed-account notice, not first use.
        expect(await guardAgrees(USER, guard, null)).toBe('changed');
        // A pin of other keys written in her place is no better.
        expect(await guardAgrees(USER, guard, await pinOf(K3))).toBe('changed');
    });

    test('a Continue on another device shows the notice here once, though its previous keys hold the guard’s', async () => {
        const guard = await guardOf(K0);
        // What another device's Continue saved: a first-seen pin of the new keys, the old signing
        // key kept as previous. A record of what that device saw, never a chain.
        const moved = await pinOf(K3, 'seen', { previousSigningKeys: [K0.signingPublicKey] });
        expect(await guardAgrees(USER, guard, moved)).toBe('changed');
        // Continue here moves this device's guard: from then on the same settings agree.
        const after = await nextGuardEntry(guard, moved);
        expect(after.revision).toBe(guard.revision + 1);
        expect(after.previousSigningKeys).toEqual([K0.signingPublicKey]);
        expect(after.verified).toBe(false);
        expect(await guardAgrees(USER, after, moved)).toBe('agrees');
    });

    test('with two devices, a Continue to K1, a check back to K0, then the stale K1 branch arriving: the notice, and K1 not taken', async () => {
        // Here: Continue to the sideways keys, then a words check back over K0.
        let guard = await guardOf(K0);
        const continued = await pinOf(K3, 'seen', { previousSigningKeys: [K0.signingPublicKey] });
        guard = await nextGuardEntry(guard, continued);
        guard = await nextGuardEntry(guard, await pinOf(K0, 'verified'));
        expect(guard.verified).toBe(true);
        expect(await guardAgrees(USER, guard, await pinOf(K0, 'verified'))).toBe('agrees');
        // The server now serves the copy from the K1 branch, at a higher sequence.
        expect(await guardAgrees(USER, guard, continued)).toBe('changed');
        expect(await guardAgrees(USER, guard, continued, { served: servedOf(K3), links: [] })).toBe(
            'changed',
        );
    });

    test('a sideways pin pauses, even with a chain that holds from keys the guard never held', async () => {
        const guard = await guardOf(K0);
        // K4 follows from K3 by a valid signature; K3 is not the guard's.
        const sideways = await pinOf(K4, 'seen', { previousSigningKeys: [K3.signingPublicKey] });
        expect(
            await guardAgrees(USER, guard, sideways, { served: servedOf(K4), links: [links.k3k4] }),
        ).toBe('changed');
        // Nor when the guard's own links are served in front of it.
        expect(
            await guardAgrees(USER, guard, sideways, {
                served: servedOf(K4),
                links: [links.k0k1, links.k3k4],
            }),
        ).toBe('changed');
    });

    test('a succession from the guard’s keys that this device verifies is taken silently, and the guard moves on', async () => {
        const guard = await guardOf(K0);
        const followed = await pinOf(K2, 'seen', { previousSigningKeys: [K0.signingPublicKey] });
        const succession = { served: servedOf(K2), links: [links.k0k1, links.k1k2] };
        expect(await guardAgrees(USER, guard, followed, succession)).toBe('follows');
        // Without the links there is nothing to verify: the notice.
        expect(await guardAgrees(USER, guard, followed)).toBe('changed');
        // Served keys other than the pin's are never what the chain is checked against.
        expect(
            await guardAgrees(USER, guard, followed, { served: servedOf(K1), links: [links.k0k1] }),
        ).toBe('changed');
        const after = await nextGuardEntry(guard, followed);
        expect(await guardAgrees(USER, after, followed)).toBe('agrees');
    });

    test('a legitimate succession is followed from the guard’s own keys after the settings replaced the old pin; a link with another old ML-DSA key is refused', async () => {
        const guard = await guardOf(K0);
        // Another device followed Maya to K1 and saved; this device's guard still holds K0.
        const replaced = await pinOf(K1);
        expect(
            await guardAgrees(USER, guard, replaced, { served: servedOf(K1), links: [links.k0k1] }),
        ).toBe('follows');
        // A link whose old X25519 and Ed25519 keys are the guard's, signed by the guard's Ed25519
        // key, but whose old ML-DSA key is another one (whose digest is not the guard's).
        const planted = K3;
        const fields = {
            oldKeyVersion: K0.keyVersion,
            newKeyVersion: K4.keyVersion,
            oldEncryptionPublicKey: K0.encryptionPublicKey,
            oldSigningPublicKey: K0.signingPublicKey,
            oldMlDsaPublicKey: planted.mlDsa.publicKey,
            newEncryptionPublicKey: K4.encryptionPublicKey,
            newSigningPublicKey: K4.signingPublicKey,
            newMlDsaPublicKey: K4.mlDsa.publicKey,
            newKemPublicKey: K4.kem.publicKey,
        };
        const k0 = await keysOf(K0);
        const signature = await signHybrid(await successionStatement({ ...fields, userId: USER }), {
            signingKey: k0.signingKey,
            mlDsaSecretKey: (await keysOf(planted)).mlDsaSecretKey,
        });
        const forged: SuccessionLink = { ...fields, signature: encode(signature) };
        expect(decode(forged.signature).length).toBeGreaterThan(64);
        expect(
            await guardAgrees(USER, guard, await pinOf(K4), {
                served: servedOf(K4),
                links: [forged],
            }),
        ).toBe('changed');
    });

    test('adding someone again over the same keys is silent; over other keys it is the notice', async () => {
        // Removed from the settings, kept by the guard.
        const guard = await guardOf(K0);
        expect(await guardAgrees(USER, guard, await pinOf(K0))).toBe('agrees');
        expect(await guardAgrees(USER, guard, await pinOf(K3))).toBe('changed');
    });

    test('a guard holds only keys a verified or first-seen pin names, and says whether it saw them verified', async () => {
        await expect(
            nextGuardEntry(null, { ...(await pinOf(K0)), mlDsaPublicKeyHash: null }),
        ).rejects.toThrow();
        const first = await guardOf(K0);
        expect(first).toMatchObject({ revision: 1, verified: false, previousSigningKeys: [] });
        const checked = await nextGuardEntry(first, await pinOf(K0, 'verified'));
        expect(checked).toMatchObject({ revision: 2, verified: true });
        // Seen again first-seen over the same keys (a Continue elsewhere then back): still seen verified here.
        expect(await nextGuardEntry(checked, await pinOf(K0))).toMatchObject({ verified: true });
        // Over other keys: not verified any more.
        expect(await nextGuardEntry(checked, await pinOf(K3))).toMatchObject({ verified: false });
    });
});

describe('a first-seen pin and a succession', () => {
    test('one signed by the first-seen keys is followed, and the pin after it is still first-seen; one signed by any other key is not', async () => {
        const before = await pinOf(K0);
        expect(await pinTrust(before)).toBe('seen');
        const pinned = {
            keyVersion: before.keyVersion,
            encryptionPublicKey: before.encryptionPublicKey,
            signingPublicKey: before.signingPublicKey,
            mlDsaPublicKeyHash: before.mlDsaPublicKeyHash,
        };
        // Signed by the first-seen keys: followed.
        expect(await verifySuccessionChain(USER, pinned, servedOf(K1), [links.k0k1])).toBe(true);
        expect(
            await verifySuccessionChain(USER, pinned, servedOf(K2), [links.k0k1, links.k1k2]),
        ).toBe(true);
        // What the pin becomes (pinAfterSuccession keeps its kind): first-seen over the new keys.
        const after = await pinKeysOfServed(servedOf(K1), 'seen');
        expect(await pinTrust(after)).toBe('seen');
        expect(await pinVerified(after)).toBe(false);
        // Signed by any other key: never followed, from these keys.
        expect(await verifySuccessionChain(USER, pinned, servedOf(K4), [links.k3k4])).toBe(false);
        expect(await verifySuccessionChain(USER, pinned, servedOf(K2), [links.k1k2])).toBe(false);
    });
});
