import { describe, expect, test } from 'vitest';
import { fingerprint } from './fingerprint';
import { pinVerified, settingsRolledBack } from './pins';

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
