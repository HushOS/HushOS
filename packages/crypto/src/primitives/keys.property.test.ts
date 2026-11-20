import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * Base64url as every record carries its bytes: canonical, unpadded, refused
 * with a CryptoError otherwise. Callers catch CryptoError as a refusal and
 * treat anything else as a broken session, so the class matters as much as
 * the verdict.
 */

describe('base64url, over generated input', () => {
    it('decodes only canonical base64url, refusing everything else with a CryptoError', () => {
        const near = fc.oneof(
            fc.string({
                unit: fc.constantFrom(...'ABCDEFabcdef0189-_+/=. '.split('')),
                maxLength: 12,
            }),
            fc.string({ maxLength: 12 }),
        );
        fc.assert(
            fc.property(near, fc.option(fc.nat(9), { nil: undefined }), (text, length) => {
                let bytes: Uint8Array | null = null;
                try {
                    bytes = decode(text, length);
                } catch (error) {
                    expect(error).toBeInstanceOf(CryptoError);
                }
                if (bytes) {
                    expect(encode(bytes)).toBe(text);
                    if (length !== undefined) expect(bytes).toHaveLength(length);
                }
            }),
            { numRuns: 3000 },
        );
    });

    it('round-trips any bytes', () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 1, maxLength: 80 }), (bytes) => {
                expect(decode(encode(bytes), bytes.length)).toEqual(bytes);
            }),
        );
    });
});
