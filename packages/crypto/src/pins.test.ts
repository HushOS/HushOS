import { describe, expect, test } from 'vitest';
import { fingerprint } from './fingerprint';
import { pinVerified, settingsRolledBack } from './pins';

/*
 * A pin counts only when it records a words check over every key it holds,
 * and a device refuses settings older than it has seen: the two things a
 * server that keeps the pins would otherwise get to decide.
 */

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const key = (fill: number) => new Uint8Array(32).fill(fill);

describe('pins', () => {
    test('a pin made by a v2 words check over both keys counts', async () => {
        const pin = {
            encryptionPublicKey: encode(key(1)),
            signingPublicKey: encode(key(2)),
            fingerprint: await fingerprint(key(1), key(2)),
        };
        expect(await pinVerified(pin)).toBe(true);
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

    test('a pin whose words covered X25519 alone (v1) does not', async () => {
        // v1: SHA-256 over the X25519 key only, as the words used to be drawn.
        const prefix = new TextEncoder().encode('hushos/identity/fingerprint/v1');
        const digest = new Uint8Array(
            await crypto.subtle.digest('SHA-256', Buffer.concat([prefix, key(1)])),
        );
        const v1 = Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, '0'))
            .join('')
            .match(/.{4}/g)!
            .join(' ');
        expect(
            await pinVerified({
                encryptionPublicKey: encode(key(1)),
                signingPublicKey: encode(key(2)),
                fingerprint: v1,
            }),
        ).toBe(false);
    });

    test('a pin whose keys were swapped after the check does not', async () => {
        const pin = {
            encryptionPublicKey: encode(key(1)),
            signingPublicKey: encode(key(3)),
            fingerprint: await fingerprint(key(1), key(2)),
        };
        expect(await pinVerified(pin)).toBe(false);
        expect(await pinVerified({ ...pin, signingPublicKey: 'not base64url!' })).toBe(false);
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
