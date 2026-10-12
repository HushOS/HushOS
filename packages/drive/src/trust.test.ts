import { describe, expect, test } from 'vitest';
import { fingerprint, keyDigest } from '@hushos/crypto/fingerprint';
import { pinVerified } from '@hushos/crypto/pins';
import {
    comparePin,
    granterKeysOf,
    integrityIssues,
    pinAfterSuccession,
    replacementUnseen,
    signersFromPins,
    type Pin,
} from './trust';

/*
 * Who a person trusts decides what Drive calls verified, which keys a share
 * opens with and when a pin moves on without a words check. Every case here is
 * one a server could try to exploit: an unchecked pin passing on trust, a key
 * swapped at the same version, a pin that forgets the keys it held.
 */

const key = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte)).toString('base64url');
const KEM = Buffer.from(new Uint8Array(1184).fill(9)).toString('base64url');
const OTHER_KEM = Buffer.from(new Uint8Array(1184).fill(8)).toString('base64url');

async function pin(overrides: Partial<Pin> = {}): Promise<Pin> {
    const base: Pin = {
        userId: 'maya',
        email: 'maya@example.com',
        name: 'Maya Lindqvist',
        encryptionPublicKey: key(1),
        signingPublicKey: key(2),
        fingerprint: await fingerprint(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)),
        pinnedAt: '2026-10-01T00:00:00.000Z',
        kemPublicKeyHash: await keyDigest(Buffer.from(KEM, 'base64url')),
        keyVersion: 1,
    };
    return { ...base, ...overrides };
}
const served = (overrides: Partial<Parameters<typeof comparePin>[1]> = {}) => ({
    keyVersion: 1,
    encryptionPublicKey: key(1),
    signingPublicKey: key(2),
    kem: { publicKey: KEM, signature: 'sig' },
    ...overrides,
});

describe('signers', () => {
    test('a verified pin vouches for its key and the earlier keys it followed', async () => {
        const followed = await pin({ previousSigningKeys: [key(6), key(7)] });
        expect(await signersFromPins({ maya: followed })).toEqual({
            maya: [key(2), key(6), key(7)],
        });
    });

    test('a pin whose words never covered its keys vouches for nobody', async () => {
        // An old-style pin: fingerprint over X25519 alone, or anything not v2 over both keys.
        const stale = await pin({ fingerprint: 'not-the-v2-fingerprint' });
        const unsigned = await pin({ signingPublicKey: '' });
        expect(await signersFromPins({ maya: stale, sam: { ...unsigned, userId: 'sam' } })).toEqual(
            {},
        );
    });
});

describe('comparing a pin with the served keys', () => {
    test('the pinned keys are the same; a swapped or missing KEM key is a change', async () => {
        const pinned = await pin();
        expect(await comparePin(pinned, served())).toBe('same');
        expect(
            await comparePin(pinned, served({ kem: { publicKey: OTHER_KEM, signature: 's' } })),
        ).toBe('changed');
        expect(await comparePin(pinned, served({ kem: null }))).toBe('changed');
    });

    test('new keys at a higher version may be a succession; at the same or lower, a change', async () => {
        const pinned = await pin({ keyVersion: 2 });
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4) };
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 3 }))).toBe('succession');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 2 }))).toBe('changed');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 1 }))).toBe('changed');
    });

    test('a pin made before successions is followed from version 1', async () => {
        const pinned = await pin({ keyVersion: null });
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4) };
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 2 }))).toBe('succession');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 1 }))).toBe('changed');
    });

    test('an unchecked pin cannot pass its trust on through a chain', async () => {
        const stale = await pin({ fingerprint: 'old' });
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4), keyVersion: 5 };
        expect(await comparePin(stale, served(moved))).toBe('changed');
    });

    test('new keys served without a KEM key cannot be a succession, which always mints one', async () => {
        const pinned = await pin();
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4), keyVersion: 2 };
        expect(await comparePin(pinned, served({ ...moved, kem: null }))).toBe('changed');
        // A granter is served without one at all: the chain will have to name it.
        expect(await comparePin(pinned, served({ ...moved, kem: undefined }))).toBe('succession');
        expect(await comparePin(pinned, served({ kem: undefined }))).toBe('same');
    });
});

describe('a pin after a succession', () => {
    test('holds the new keys under a fresh v2 fingerprint and keeps the old ones', async () => {
        const before = await pin();
        const after = await pinAfterSuccession(
            before,
            { keyVersion: 2, encryptionPublicKey: key(3), signingPublicKey: key(4) },
            OTHER_KEM,
            new Date('2026-10-12T10:00:00.000Z'),
        );
        expect(after).toMatchObject({
            encryptionPublicKey: key(3),
            signingPublicKey: key(4),
            keyVersion: 2,
            kemPublicKeyHash: await keyDigest(Buffer.from(OTHER_KEM, 'base64url')),
            previousSigningKeys: [key(2)],
            keysReplacedAt: '2026-10-12T10:00:00.000Z',
            resealShares: true,
            // When the words were compared does not move: the notice asks to compare again.
            pinnedAt: before.pinnedAt,
        });
        expect(await pinVerified(after)).toBe(true);
        // The served KEM key now matches; the old one would be a change.
        const now = { encryptionPublicKey: key(3), signingPublicKey: key(4), keyVersion: 2 };
        expect(
            await comparePin(
                after,
                served({ ...now, kem: { publicKey: OTHER_KEM, signature: 's' } }),
            ),
        ).toBe('same');
        expect(await comparePin(after, served(now))).toBe('changed');
        // Records signed before the succession still verify: both signing keys count.
        expect(await signersFromPins({ maya: after })).toEqual({ maya: [key(4), key(2)] });
        // And shares sealed before it open: newest keys first, then the earlier.
        expect(granterKeysOf(after).map((k) => k.signingPublicKey)).toEqual([key(4), key(2)]);
    });
});

describe('a second succession', () => {
    test('appends the replaced key, oldest first, and tries the newest keys first', async () => {
        const once = await pinAfterSuccession(
            await pin(),
            { keyVersion: 2, encryptionPublicKey: key(3), signingPublicKey: key(4) },
            KEM,
            new Date('2026-10-12T10:00:00.000Z'),
        );
        const twice = await pinAfterSuccession(
            once,
            { keyVersion: 3, encryptionPublicKey: key(5), signingPublicKey: key(6) },
            OTHER_KEM,
            new Date('2026-10-13T10:00:00.000Z'),
        );
        expect(twice.previousSigningKeys).toEqual([key(2), key(4)]);
        expect(granterKeysOf(twice).map((k) => k.signingPublicKey)).toEqual([
            key(6),
            key(4),
            key(2),
        ]);
        // People says so until the person dismisses this replacement; a later one shows again.
        expect(replacementUnseen(twice)).toBe(true);
        expect(replacementUnseen({ ...twice, replacementSeen: twice.keysReplacedAt })).toBe(false);
        expect(replacementUnseen({ ...twice, replacementSeen: once.keysReplacedAt })).toBe(true);
    });
});

describe('what an item shows', () => {
    const maya = { id: 'maya', name: 'Maya', email: 'maya@example.com' };
    const sam = { id: 'sam', name: 'Sam', email: 'sam@example.com' };

    test('a verified item, or one never checked, shows nothing', () => {
        expect(
            integrityIssues({
                metadataSigner: maya,
                currentVersion: { signer: maya },
                integrity: { metadata: 'verified', version: 'verified' },
            }),
        ).toEqual([]);
        expect(
            integrityIssues({ metadataSigner: null, currentVersion: null, integrity: null }),
        ).toEqual([]);
    });

    test('both records explained, worst first, each with the writer the server named', () => {
        expect(
            integrityIssues({
                metadataSigner: maya,
                currentVersion: { signer: sam },
                integrity: { metadata: 'unsigned', version: 'bad-signature' },
            }),
        ).toEqual([
            { record: 'version', integrity: 'bad-signature', signer: sam },
            { record: 'metadata', integrity: 'unsigned', signer: maya },
        ]);
    });
});
