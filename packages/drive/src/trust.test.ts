import { describe, expect, test } from 'vitest';
import { fingerprint, keyDigest } from '@hushos/crypto/fingerprint';
import { pinVerified } from '@hushos/crypto/pins';
import {
    comparePin,
    copySignatureForms,
    granterKeysOf,
    integrityIssues,
    signatureFormFor,
    pinAfterSuccession,
    replacementUnseen,
    signersFromPins,
    type Pin,
} from './trust';

/*
 * Who a person trusts decides what Drive calls verified, which keys a share
 * opens with and when a pin moves on without a words check. Every case here is
 * one a server could try to exploit: an unchecked pin passing on trust, a key
 * swapped at the same version, a pin that forgets the keys it held, a pin from
 * before the post-quantum release trusted over keys its words never covered.
 */

const key = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte)).toString('base64url');
const lattice = (bytes: number, fill: number) =>
    Buffer.from(new Uint8Array(bytes).fill(fill)).toString('base64url');
const KEM = lattice(1184, 9);
const OTHER_KEM = lattice(1184, 8);
const ML_DSA = lattice(1952, 5);
const OTHER_ML_DSA = lattice(1952, 6);
const bytesOf = (value: string) => Buffer.from(value, 'base64url');
const digest = (value: string) => keyDigest(bytesOf(value));
const hexBytes = (hex: string) => Buffer.from(hex, 'hex');

/* A version 3 pin of Maya: her four keys as the words compared them. */
async function pin(overrides: Partial<Pin> = {}): Promise<Pin> {
    const mlDsaPublicKeyHash = await digest(ML_DSA);
    const kemPublicKeyHash = await digest(KEM);
    const base: Pin = {
        userId: 'maya',
        email: 'maya@example.com',
        name: 'Maya Lindqvist',
        encryptionPublicKey: key(1),
        signingPublicKey: key(2),
        mlDsaPublicKeyHash,
        kemPublicKeyHash,
        fingerprint: await fingerprint(
            bytesOf(key(1)),
            bytesOf(key(2)),
            hexBytes(mlDsaPublicKeyHash),
            hexBytes(kemPublicKeyHash),
        ),
        pinnedAt: '2026-10-01T00:00:00.000Z',
        keyVersion: 1,
    };
    return { ...base, ...overrides };
}
/* A pin made before the release: the version 2 fingerprint over X25519 and Ed25519 alone. */
async function versionTwoPin(): Promise<Pin> {
    const prefix = new TextEncoder().encode('hushos/identity/fingerprint/v2');
    const value = new Uint8Array(
        await crypto.subtle.digest(
            'SHA-256',
            Buffer.concat([prefix, bytesOf(key(1)), bytesOf(key(2))]),
        ),
    );
    const print = Array.from(value.subarray(0, 20), (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .match(/.{4}/g)!
        .join(' ');
    const { mlDsaPublicKeyHash: _gone, ...rest } = await pin();
    return { ...rest, fingerprint: print };
}
const served = (overrides: Partial<Parameters<typeof comparePin>[1]> = {}) => ({
    keyVersion: 1,
    encryptionPublicKey: key(1),
    signingPublicKey: key(2),
    mlDsaPublicKey: ML_DSA as string | null,
    kemPublicKey: KEM as string | null,
    ...overrides,
});

describe('signers', () => {
    test('a verified pin vouches for its current key; the keys it followed from are only retired', async () => {
        const followed = await pin({ previousSigningKeys: [key(6), key(7)] });
        expect(await signersFromPins({ maya: followed })).toEqual({
            maya: { current: key(2), retired: [key(6), key(7)] },
        });
    });

    test('a pin whose words never covered all four keys vouches for nobody', async () => {
        const stale = await pin({ fingerprint: 'not-the-v3-fingerprint' });
        const unsigned = await pin({ signingPublicKey: '' });
        const before = await versionTwoPin();
        expect(
            await signersFromPins({
                maya: stale,
                sam: { ...unsigned, userId: 'sam' },
                ana: { ...before, userId: 'ana' },
            }),
        ).toEqual({});
    });
});

describe('comparing a pin with the served keys', () => {
    test('the pinned keys are the same; a swapped or missing ML-DSA or ML-KEM key is a change', async () => {
        const pinned = await pin();
        expect(await comparePin(pinned, served())).toBe('same');
        expect(await comparePin(pinned, served({ kemPublicKey: OTHER_KEM }))).toBe('changed');
        expect(await comparePin(pinned, served({ kemPublicKey: null }))).toBe('changed');
        // The pinned classical keys beside another ML-DSA key: what a quantum forger would serve.
        expect(await comparePin(pinned, served({ mlDsaPublicKey: OTHER_ML_DSA }))).toBe('changed');
        // The version 1 form, stripped of its ML-DSA key: a downgrade.
        expect(await comparePin(pinned, served({ mlDsaPublicKey: null }))).toBe('changed');
    });

    test('a pin from before the release asks for the words again over the same keys, whatever is served', async () => {
        const before = await versionTwoPin();
        expect(await pinVerified(before)).toBe(false);
        // Upgraded, or served as the version 1 form: either way only a words check trusts it.
        expect(await comparePin(before, served())).toBe('recheck');
        expect(await comparePin(before, served({ mlDsaPublicKey: null }))).toBe('recheck');
        // Other keys are the changed-key warning, as ever.
        expect(
            await comparePin(before, served({ encryptionPublicKey: key(3), keyVersion: 2 })),
        ).toBe('changed');
    });

    test('new keys at a higher version may be a succession; at the same or lower, a change', async () => {
        const pinned = await pin({ keyVersion: 2 });
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4) };
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 3 }))).toBe('succession');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 2 }))).toBe('changed');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 1 }))).toBe('changed');
    });

    test('a pin with no version is followed from version 1', async () => {
        const pinned = await pin({ keyVersion: null });
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4) };
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 2 }))).toBe('succession');
        expect(await comparePin(pinned, served({ ...moved, keyVersion: 1 }))).toBe('changed');
    });

    test('an unchecked pin, or one from before the release, cannot pass its trust on through a chain', async () => {
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4), keyVersion: 5 };
        expect(await comparePin(await pin({ fingerprint: 'old' }), served(moved))).toBe('changed');
        expect(await comparePin(await versionTwoPin(), served(moved))).toBe('changed');
    });

    test('new keys served without an ML-DSA or ML-KEM key cannot be a succession', async () => {
        const pinned = await pin();
        const moved = { encryptionPublicKey: key(3), signingPublicKey: key(4), keyVersion: 2 };
        expect(await comparePin(pinned, served({ ...moved, kemPublicKey: null }))).toBe('changed');
        expect(await comparePin(pinned, served({ ...moved, mlDsaPublicKey: null }))).toBe(
            'changed',
        );
    });
});

describe('a pin after a succession', () => {
    test('holds the new keys as a version 3 pin and keeps the old ones', async () => {
        const before = await pin();
        const next = {
            keyVersion: 2,
            encryptionPublicKey: key(3),
            signingPublicKey: key(4),
            mlDsaPublicKey: OTHER_ML_DSA,
            kemPublicKey: OTHER_KEM,
        };
        const after = await pinAfterSuccession(before, next, new Date('2026-10-12T10:00:00.000Z'));
        expect(after).toMatchObject({
            encryptionPublicKey: key(3),
            signingPublicKey: key(4),
            keyVersion: 2,
            mlDsaPublicKeyHash: await digest(OTHER_ML_DSA),
            kemPublicKeyHash: await digest(OTHER_KEM),
            previousSigningKeys: [key(2)],
            keysReplacedAt: '2026-10-12T10:00:00.000Z',
            resealShares: true,
            // When the words were compared does not move: the notice asks to compare again.
            pinnedAt: before.pinnedAt,
        });
        expect(await pinVerified(after)).toBe(true);
        expect(await comparePin(after, served(next))).toBe('same');
        // The old lattice keys beside the new classical ones would be a change.
        expect(await comparePin(after, served({ ...next, kemPublicKey: KEM }))).toBe('changed');
        expect(await comparePin(after, served({ ...next, mlDsaPublicKey: ML_DSA }))).toBe(
            'changed',
        );
        // Records signed before the succession read as a retired key, never as verified.
        expect(await signersFromPins({ maya: after })).toEqual({
            maya: { current: key(4), retired: [key(2)] },
        });
        // A share opens only against the current keys: the pinned Ed25519 key, and the served
        // ML-DSA key only when its digest is the pin's.
        expect(await granterKeysOf(after, { mlDsaPublicKey: OTHER_ML_DSA })).toEqual({
            signingPublicKey: key(4),
            mlDsaPublicKey: OTHER_ML_DSA,
        });
        expect(await granterKeysOf(after, { mlDsaPublicKey: ML_DSA })).toBeNull();
        expect(await granterKeysOf(after, { mlDsaPublicKey: null })).toBeNull();
        expect(await granterKeysOf(await versionTwoPin(), { mlDsaPublicKey: ML_DSA })).toBeNull();
    });
});

describe('a second succession', () => {
    test('appends the replaced key, oldest first, and opens shares with the newest only', async () => {
        const once = await pinAfterSuccession(
            await pin(),
            {
                keyVersion: 2,
                encryptionPublicKey: key(3),
                signingPublicKey: key(4),
                mlDsaPublicKey: OTHER_ML_DSA,
                kemPublicKey: KEM,
            },
            new Date('2026-10-12T10:00:00.000Z'),
        );
        const twice = await pinAfterSuccession(
            once,
            {
                keyVersion: 3,
                encryptionPublicKey: key(5),
                signingPublicKey: key(6),
                mlDsaPublicKey: ML_DSA,
                kemPublicKey: OTHER_KEM,
            },
            new Date('2026-10-13T10:00:00.000Z'),
        );
        expect(twice.previousSigningKeys).toEqual([key(2), key(4)]);
        expect(await granterKeysOf(twice, { mlDsaPublicKey: ML_DSA })).toEqual({
            signingPublicKey: key(6),
            mlDsaPublicKey: ML_DSA,
        });
        // People says so until the person dismisses this replacement; a later one shows again.
        expect(replacementUnseen(twice)).toBe(true);
        expect(replacementUnseen({ ...twice, replacementSeen: twice.keysReplacedAt })).toBe(false);
        expect(replacementUnseen({ ...twice, replacementSeen: once.keysReplacedAt })).toBe(true);
    });
});

describe('what an item shows', () => {
    const maya = { id: 'maya', name: 'Maya', email: 'maya@example.com' };
    const sam = { id: 'sam', name: 'Sam', email: 'sam@example.com' };

    test('a verified item, or one with nothing to check, shows nothing', () => {
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

    test('a copy saved from a link is no issue; a saved name over an unverified version still is', () => {
        expect(
            integrityIssues({
                metadataSigner: maya,
                currentVersion: { signer: maya },
                integrity: { metadata: 'saved-from-link', version: 'saved-from-link' },
            }),
        ).toEqual([]);
        expect(
            integrityIssues({
                metadataSigner: maya,
                currentVersion: { signer: sam },
                integrity: { metadata: 'saved-from-link', version: 'resealed' },
            }),
        ).toEqual([{ record: 'version', integrity: 'resealed', signer: sam }]);
    });

    test('every verdict but verified is an issue: unsigned, re-sealed, retired and unchecked included', () => {
        for (const integrity of [
            'unsigned',
            'resealed',
            'retired-key',
            'unknown-signer',
            'bad-signature',
            'unchecked',
        ] as const)
            expect(
                integrityIssues({
                    metadataSigner: maya,
                    currentVersion: null,
                    integrity: { metadata: integrity, version: null },
                }),
            ).toEqual([{ record: 'metadata', integrity, signer: maya }]);
        // A bad signature outranks a check that did not run, so a server cannot hide one behind it.
        expect(
            integrityIssues({
                metadataSigner: maya,
                currentVersion: { signer: sam },
                integrity: { metadata: 'unchecked', version: 'bad-signature' },
            })[0]!.integrity,
        ).toBe('bad-signature');
    });
});

describe('what a copy, a rename or a recreated folder is signed with', () => {
    const issues = [
        'resealed',
        'retired-key',
        'unknown-signer',
        'bad-signature',
        'unsigned',
        'unchecked',
    ] as const;

    test('from a link: saved, files and folders alike, whatever the original showed', () => {
        for (const prior of [...issues, 'verified', 'saved-from-link', null] as const) {
            expect(signatureFormFor(prior, 'link')).toBe('saved');
            expect(
                copySignatureForms(
                    { kind: 'file', integrity: prior ? { metadata: prior, version: prior } : null },
                    'link',
                ),
            ).toEqual({ metadata: 'saved', version: 'saved' });
        }
        expect(copySignatureForms({ kind: 'folder', integrity: null }, 'link').metadata).toBe(
            'saved',
        );
    });

    test('otherwise: ordinary only for what verified, saved only for what verified as saved', () => {
        expect(signatureFormFor('verified')).toBe('ordinary');
        expect(signatureFormFor('saved-from-link')).toBe('saved');
        // Unverified, Couldn't check, re-sealed, retired keys, never checked: re-sealed.
        for (const prior of [...issues, null, undefined])
            expect(signatureFormFor(prior)).toBe('resealed');
    });

    test('a file’s two records are chosen apart, so a verified name never covers unverified content', () => {
        expect(
            copySignatureForms(
                { kind: 'file', integrity: { metadata: 'verified', version: 'unknown-signer' } },
                'drive',
            ),
        ).toEqual({ metadata: 'ordinary', version: 'resealed' });
        expect(
            copySignatureForms(
                { kind: 'file', integrity: { metadata: 'verified', version: null } },
                'drive',
            ),
        ).toEqual({ metadata: 'ordinary', version: 'resealed' });
        expect(
            copySignatureForms(
                { kind: 'file', integrity: { metadata: 'verified', version: 'verified' } },
                'drive',
            ),
        ).toEqual({ metadata: 'ordinary', version: 'ordinary' });
        expect(copySignatureForms({ kind: 'file', integrity: null }, 'drive')).toEqual({
            metadata: 'resealed',
            version: 'resealed',
        });
    });
});
