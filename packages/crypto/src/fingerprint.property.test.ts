import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { digestBase64url, digestHex, fingerprint, sameKeyDigest } from './fingerprint';
import { checkGroupPin, pinVerified } from './pins';

/*
 * Key digests move between contact pins (hex) and group statements
 * (base64url); a pin and a roster entry must only ever match as the same
 * bytes. Pins come back from the server inside the settings document, so
 * their checks see whatever it holds.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

describe('key digests, over generated input', () => {
    it('convert a 32-byte digest both ways and nothing else', () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (digest) => {
                expect(digestHex(base64url(digest))).toBe(hex(digest));
                expect(digestBase64url(hex(digest))).toBe(base64url(digest));
                expect(sameKeyDigest(hex(digest), base64url(digest))).toBe(true);
                expect(sameKeyDigest(hex(digest).toUpperCase(), base64url(digest))).toBe(
                    hex(digest) === hex(digest).toUpperCase(),
                );
            }),
        );
    });

    it('refuse other strings with a CryptoError, and say two digests are the same only when they are', () => {
        const near = fc.oneof(
            fc.string({
                unit: fc.constantFrom(...'0123456789abcdefABCDEF-_='.split('')),
                minLength: 40,
                maxLength: 66,
            }),
            fc.string({ maxLength: 66 }),
        );
        fc.assert(
            fc.property(near, near, (a, b) => {
                // Whatever converts one way converts back to exactly the string given.
                for (const [there, back] of [
                    [digestHex, digestBase64url],
                    [digestBase64url, digestHex],
                ] as const) {
                    let converted: string | null = null;
                    try {
                        converted = there(a);
                    } catch (error) {
                        expect(error).toBeInstanceOf(CryptoError);
                    }
                    if (converted !== null) expect(back(converted)).toBe(a);
                }
                if (sameKeyDigest(a, b)) expect(digestBase64url(a)).toBe(b);
            }),
            { numRuns: 2000 },
        );
    });
});

describe('pins, over generated input', () => {
    it('verify a pin only over a fingerprint of the very keys it holds, and never throw', async () => {
        const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
        await fc.assert(
            fc.asyncProperty(key, key, key, key, fc.nat(4), async (x, ed, mlDsa, kem, change) => {
                const pin = {
                    encryptionPublicKey: base64url(x),
                    signingPublicKey: base64url(ed),
                    mlDsaPublicKeyHash: hex(mlDsa),
                    kemPublicKeyHash: hex(kem),
                    fingerprint: await fingerprint(x, ed, mlDsa, kem),
                };
                expect(await pinVerified(pin)).toBe(true);
                // Any one field otherwise, and it is no longer a words check over these keys.
                const changed = { ...pin };
                if (change === 0) changed.encryptionPublicKey = `${pin.encryptionPublicKey}=`;
                if (change === 1) changed.signingPublicKey = base64url(x);
                if (change === 2) changed.mlDsaPublicKeyHash = pin.mlDsaPublicKeyHash.toUpperCase();
                if (change === 3) changed.kemPublicKeyHash = hex(mlDsa);
                if (change === 4) changed.fingerprint = pin.fingerprint.replaceAll(' ', '');
                const same =
                    JSON.stringify(changed) === JSON.stringify(pin) ||
                    (change === 1 && base64url(x) === base64url(ed)) ||
                    (change === 3 && hex(mlDsa) === hex(kem));
                expect(await pinVerified(changed)).toBe(same);
            }),
            { numRuns: 200 },
        );
    });

    it('check a group pin with a CryptoError for anything malformed, and keep a pin that passes as it was', () => {
        // Mostly well-formed fields, so whole pins pass often enough for the second half to mean something.
        const noise = fc.oneof(
            fc.string({ maxLength: 8 }),
            fc.constantFrom(
                0,
                2 ** 53,
                1.5,
                -1,
                '2026-13-15T00:00:00.000Z',
                'IL2SXFIO1S4PS06ZLGBCAUJ8YSWSAFKXQZIRZFLKTK8',
            ),
            fc.constant(null),
        );
        const or = <T>(valid: fc.Arbitrary<T>) =>
            fc.oneof({ weight: 5, arbitrary: valid }, { weight: 1, arbitrary: noise });
        const key = or(fc.uint8Array({ minLength: 32, maxLength: 32 }).map(base64url));
        const version = or(fc.integer({ min: 1, max: 2 ** 53 - 1 }));
        const pin = fc.record({
            firstEd25519PublicKey: key,
            firstMlDsaPublicKeyDigest: key,
            checkedAt: or(
                fc
                    .date({ noInvalidDate: true, min: new Date(0), max: new Date('9999-12-31') })
                    .map((d) => d.toISOString()),
            ),
            keyVersion: version,
            groupKeyDigest: key,
            rosterVersion: version,
            rosterDigest: key,
            areas: or(
                fc.dictionary(or(fc.uuid().map((u) => u.toLowerCase())).map(String), version, {
                    maxKeys: 2,
                }),
            ),
        });
        fc.assert(
            fc.property(pin, (candidate) => {
                let checked: unknown = null;
                try {
                    checked = checkGroupPin('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', candidate);
                } catch (error) {
                    expect(error).toBeInstanceOf(CryptoError);
                }
                if (checked) expect(checked).toEqual(candidate);
            }),
            { numRuns: 2000 },
        );
    });
});
