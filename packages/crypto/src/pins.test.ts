import { describe, expect, test } from 'vitest';
import { fingerprint } from './fingerprint';
import { CryptoError } from './errors';
import {
    checkGroupPin,
    guardAfter,
    keyCommitment,
    pinKeysOfServed,
    pinTrust,
    pinVerified,
    settingsRolledBack,
} from './pins';

/*
 * A pin counts only when it records a version 3 words check over every key it
 * holds, and a device refuses settings older than it has seen: the two things
 * a server that keeps the pins would otherwise get to decide.
 */

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const key = (fill: number) => new Uint8Array(32).fill(fill);

/* A version 3 pin over four keys, as comparing words writes it. */
async function v3(x: number, ed: number, mlDsa: number, kem: number) {
    return {
        encryptionPublicKey: encode(key(x)),
        signingPublicKey: encode(key(ed)),
        mlDsaPublicKeyHash: hex(key(mlDsa)),
        kemPublicKeyHash: hex(key(kem)),
        fingerprint: await fingerprint(key(x), key(ed), key(mlDsa), key(kem)),
    };
}

/* The version 2 fingerprint, over X25519 and Ed25519 alone, as pins made before carry it. */
async function v2Print(x: Uint8Array, ed: Uint8Array) {
    const prefix = new TextEncoder().encode('hushos/identity/fingerprint/v2');
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', Buffer.concat([prefix, x, ed])),
    );
    return Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .match(/.{4}/g)!
        .join(' ');
}

describe('pins', () => {
    test('a pin made by a version 3 words check over all four keys counts', async () => {
        expect(await pinVerified(await v3(1, 2, 3, 4))).toBe(true);
    });

    test('a version 2 pin, over X25519 and Ed25519 alone, counts for nothing', async () => {
        // A genuine words check from before the release: its words never covered ML-DSA.
        const pin = {
            encryptionPublicKey: encode(key(1)),
            signingPublicKey: encode(key(2)),
            kemPublicKeyHash: hex(key(4)),
            fingerprint: await v2Print(key(1), key(2)),
        };
        expect(await pinVerified(pin)).toBe(false);
        // Nor does adding an ML-DSA digest to it after the fact make it one.
        expect(await pinVerified({ ...pin, mlDsaPublicKeyHash: hex(key(3)) })).toBe(false);
    });

    test('a pin taken on first use, without a signing key, does not', async () => {
        expect(
            await pinVerified({
                encryptionPublicKey: encode(key(1)),
                signingPublicKey: '',
                fingerprint: 'anything',
            }),
        ).toBe(false);
    });

    test('a pin with any of its four keys swapped after the check does not', async () => {
        const pin = await v3(1, 2, 3, 4);
        expect(await pinVerified({ ...pin, encryptionPublicKey: encode(key(9)) })).toBe(false);
        expect(await pinVerified({ ...pin, signingPublicKey: encode(key(9)) })).toBe(false);
        expect(await pinVerified({ ...pin, mlDsaPublicKeyHash: hex(key(9)) })).toBe(false);
        expect(await pinVerified({ ...pin, kemPublicKeyHash: hex(key(9)) })).toBe(false);
        expect(await pinVerified({ ...pin, kemPublicKeyHash: null })).toBe(false);
        expect(await pinVerified({ ...pin, signingPublicKey: 'not base64url!' })).toBe(false);
        expect(await pinVerified({ ...pin, mlDsaPublicKeyHash: 'NOT HEX' })).toBe(false);
        // A non-canonical encoding of the same key (spare bits set, or padding) is refused, as the
        // Rust core refuses it, so a pin never verifies on one client and not another.
        const last = pin.signingPublicKey.at(-1)!;
        const sibling = 'AEIMQUYcgkosw048'.includes(last)
            ? String.fromCharCode(last.charCodeAt(0) + 1)
            : last;
        expect(
            await pinVerified({
                ...pin,
                signingPublicKey: pin.signingPublicKey.slice(0, -1) + sibling,
            }),
        ).toBe(false);
        expect(
            await pinVerified({ ...pin, encryptionPublicKey: `${pin.encryptionPublicKey}=` }),
        ).toBe(false);
    });
});

/* A first-seen pin over four keys: the same key fields, and "" for the fingerprint. */
async function seen(x: number, ed: number, mlDsa: number, kem: number) {
    return { ...(await v3(x, ed, mlDsa, kem)), fingerprint: '' };
}

describe('first-seen pins', () => {
    test('a first-seen pin never passes pinVerified, nor when its "" is replaced by a fingerprint over other keys', async () => {
        const pin = await seen(1, 2, 3, 4);
        expect(await pinVerified(pin)).toBe(false);
        expect(await pinTrust(pin)).toBe('seen');
        // Someone writes a real fingerprint into it, but over keys the pin does not hold.
        for (const other of [
            await v3(9, 2, 3, 4),
            await v3(1, 9, 3, 4),
            await v3(1, 2, 9, 4),
            await v3(1, 2, 3, 9),
        ]) {
            const forged = { ...pin, fingerprint: other.fingerprint };
            expect(await pinVerified(forged)).toBe(false);
            // Not verified, and not first-seen either: it can be pinned again, never trusted.
            expect(await pinTrust(forged)).toBe('invalid');
        }
        // The fingerprint over its own keys is a words check: that one is verified.
        expect(await pinTrust({ ...pin, fingerprint: (await v3(1, 2, 3, 4)).fingerprint })).toBe(
            'verified',
        );
    });

    test('first-seen needs "" exactly and every key field well formed; without an ML-DSA digest it is legacy', async () => {
        const pin = await seen(1, 2, 3, 0xab);
        const { fingerprint: _, ...unprinted } = pin;
        expect(await pinTrust(unprinted as never)).toBe('invalid');
        expect(await pinTrust({ ...pin, fingerprint: ' ' })).toBe('invalid');
        expect(await pinTrust({ ...pin, kemPublicKeyHash: null })).toBe('invalid');
        expect(
            await pinTrust({ ...pin, kemPublicKeyHash: pin.kemPublicKeyHash.toUpperCase() }),
        ).toBe('invalid');
        expect(await pinTrust({ ...pin, signingPublicKey: `${pin.signingPublicKey}=` })).toBe(
            'invalid',
        );
        expect(await pinTrust({ ...pin, encryptionPublicKey: encode(new Uint8Array(31)) })).toBe(
            'invalid',
        );
        expect(await pinTrust({ ...pin, mlDsaPublicKeyHash: null })).toBe('legacy');
        expect(await pinTrust({ ...pin, mlDsaPublicKeyHash: undefined })).toBe('legacy');
    });

    test('keys are told apart by their commitment, never by the fingerprint field', async () => {
        const a = await seen(1, 2, 3, 4);
        const b = await seen(1, 2, 3, 5);
        // Two first-seen pins of other keys hold the same "" but not the same keys.
        expect(a.fingerprint).toBe(b.fingerprint);
        expect(await keyCommitment(a)).not.toBe(await keyCommitment(b));
        // The commitment is the version 3 fingerprint over the four keys, verified or not.
        expect(await keyCommitment(a)).toBe((await v3(1, 2, 3, 4)).fingerprint);
        expect(await keyCommitment(await v3(1, 2, 3, 4))).toBe(await keyCommitment(a));
        expect(await keyCommitment({ ...a, mlDsaPublicKeyHash: null })).toBeNull();
        expect(await keyCommitment({ ...a, encryptionPublicKey: 'not a key' })).toBeNull();
    });

    test('a pin of served keys is first-seen or verified as asked, over the very keys served', async () => {
        const served = {
            keyVersion: 3,
            encryptionPublicKey: encode(key(1)),
            signingPublicKey: encode(key(2)),
            mlDsaPublicKey: encode(new Uint8Array(1952).fill(3)),
            kemPublicKey: encode(new Uint8Array(1184).fill(4)),
        };
        const first = await pinKeysOfServed(served, 'seen');
        expect(first.fingerprint).toBe('');
        expect(first.keyVersion).toBe(3);
        expect(await pinTrust(first)).toBe('seen');
        const checked = await pinKeysOfServed(served, 'verified');
        expect(await pinTrust(checked)).toBe('verified');
        expect(await keyCommitment(first)).toBe(checked.fingerprint);
        // A key not in canonical form, or a lattice key of the wrong size, makes no pin at all.
        await expect(
            pinKeysOfServed({ ...served, signingPublicKey: `${served.signingPublicKey}=` }, 'seen'),
        ).rejects.toThrow(CryptoError);
        await expect(
            pinKeysOfServed({ ...served, kemPublicKey: encode(new Uint8Array(1183)) }, 'seen'),
        ).rejects.toThrow(CryptoError);
    });
});

describe('settings served back', () => {
    test('an older version, or none after one was seen, is a rollback', () => {
        expect(settingsRolledBack(4, 5)).toBe(true);
        expect(settingsRolledBack(null, 1)).toBe(true);
    });

    test('the same or a newer version, or none on a device that has seen none, is not', () => {
        expect(settingsRolledBack(5, 5)).toBe(false);
        expect(settingsRolledBack(6, 5)).toBe(false);
        expect(settingsRolledBack(null, 0)).toBe(false);
        expect(settingsRolledBack(1, 0)).toBe(false);
    });
});

describe('group pins', () => {
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const AREA = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
    const pin = {
        firstEd25519PublicKey: encode(key(1)),
        firstMlDsaPublicKeyDigest: encode(key(2)),
        checkedAt: '2026-10-15T00:00:00.000Z',
        keyVersion: 2,
        groupKeyDigest: encode(key(5)),
        rosterVersion: 5,
        rosterDigest: encode(key(3)),
        areas: { [AREA]: 3 },
    };

    test('a pin outside the canonical encoding is no pin, and nothing beyond its fields is kept', () => {
        expect(checkGroupPin(GROUP, pin)).toEqual(pin);
        // Marks the old shape carried are dropped, never trusted.
        expect(
            checkGroupPin(GROUP, {
                ...pin,
                earlierRosters: [{ rosterVersion: 2 }],
                droppedHolder: true,
            }),
        ).toEqual(pin);
        for (const broken of [
            { ...pin, firstMlDsaPublicKeyDigest: hex(key(2)) },
            { ...pin, groupKeyDigest: hex(key(5)) },
            { ...pin, rosterDigest: '' },
            { ...pin, keyVersion: 0 },
            { ...pin, rosterVersion: 2 ** 53 },
            { ...pin, checkedAt: '' },
            { ...pin, areas: { [AREA.toUpperCase()]: 1 } },
            { ...pin, areas: { [AREA]: 0 } },
            { ...pin, areas: [] },
            { ...pin, firstEd25519PublicKey: `${pin.firstEd25519PublicKey}=` },
        ])
            expect(() => checkGroupPin(GROUP, broken)).toThrow(CryptoError);
        expect(() => checkGroupPin(GROUP.toUpperCase(), pin)).toThrow('Invalid group id.');
    });
});

describe('the family guard (docs/optional-verification.md 2.8)', () => {
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const AREA = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
    const at = (rosterVersion: number, keyVersion: number, areas: Record<string, number> = {}) => ({
        firstEd25519PublicKey: encode(key(1)),
        firstMlDsaPublicKeyDigest: encode(key(2)),
        checkedAt: '2026-10-15T00:00:00.000Z',
        keyVersion,
        groupKeyDigest: encode(key(10 + keyVersion)),
        rosterVersion,
        rosterDigest: encode(key(20 + rosterVersion)),
        areas,
    });

    test('moves on with each acceptance and the folders opened here, and never goes back', () => {
        // None held: the accepted pin, with what this device opened.
        expect(
            guardAfter(GROUP, null, at(3, 1), [{ groupId: GROUP, workspaceId: AREA, version: 1 }]),
        ).toEqual(at(3, 1, { [AREA]: 1 }));
        // A later roster and key: the guard moves there, keeping its own floors.
        expect(guardAfter(GROUP, at(3, 1, { [AREA]: 2 }), at(5, 2))).toEqual(
            at(5, 2, { [AREA]: 2 }),
        );
        // The same chain, and a folder opened at a later version: only the floor rises.
        expect(
            guardAfter(GROUP, at(5, 2, { [AREA]: 1 }), at(5, 2), [
                { groupId: GROUP, workspaceId: AREA, version: 2 },
            ]),
        ).toEqual(at(5, 2, { [AREA]: 2 }));
        // Nothing new: nothing to write.
        expect(guardAfter(GROUP, at(5, 2, { [AREA]: 2 }), at(5, 2))).toBeNull();
        // An older pin never lowers it: the guard covers it.
        expect(guardAfter(GROUP, at(5, 2), at(3, 1))).toBeNull();
        // One that disagrees never replaces it, and is no coverage either (a wipe drops nothing
        // over it): another roster or group key at one version, or other first keys.
        expect(guardAfter(GROUP, at(5, 2), { ...at(5, 2), rosterDigest: encode(key(99)) })).toBe(
            'conflict',
        );
        expect(guardAfter(GROUP, at(5, 2), { ...at(5, 2), groupKeyDigest: encode(key(98)) })).toBe(
            'conflict',
        );
        expect(
            guardAfter(GROUP, at(5, 2), { ...at(6, 2), firstEd25519PublicKey: encode(key(9)) }),
        ).toBe('conflict');
    });
});
