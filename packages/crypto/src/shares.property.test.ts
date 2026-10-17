import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './errors';
import { openIdentityEncryptionKey, openIdentityKemKey, type IdentityEnvelope } from './identity';
import { decode, encode } from './keys';
import { openShareKey } from './shares';
import core from './__fixtures__/core.json';
import web from '../../../crates/hushos-core/fixtures/web.json';

/*
 * A share the Rust core sealed (core.json), opened by this twin's identity
 * (web.json), with bytes changed, cut or added: it opens to its node key only
 * as it was sealed, and refuses anything else with a CryptoError, before any
 * secret is used for a share whose signature does not hold.
 */

describe('shares, over changed envelopes', () => {
    it('open only as sealed, and refuse any change with a CryptoError', async () => {
        const root = decode(web.account.accountKey, 32);
        const identity = web.share.identity as unknown as IdentityEnvelope;
        const grantee = {
            privateKey: await openIdentityEncryptionKey(root, web.account.userId, identity),
            kemSecretKey: (await openIdentityKemKey(root, web.account.userId, identity))!.secretKey,
        };
        const granter = {
            signingPublicKey: decode(core.share.granterSigningPublicKey, 32),
            mlDsaPublicKey: decode(core.share.granterMlDsaPublicKey, 1952),
        };
        const sealed = decode(core.share.signed);
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), { maxLength: 2 }),
                fc.integer({ min: -3, max: 3 }),
                async (flips, resize) => {
                    const envelope = Uint8Array.from(sealed);
                    for (const [at, mask] of flips) envelope[at % envelope.length]! ^= mask;
                    const changed =
                        resize < 0
                            ? envelope.subarray(0, envelope.length + resize)
                            : Uint8Array.from([...envelope, ...new Uint8Array(resize)]);
                    let key: string | null = null;
                    try {
                        key = encode(await openShareKey(changed, granter, grantee, core.share.ctx));
                    } catch (error) {
                        expect(error).toBeInstanceOf(CryptoError);
                    }
                    const untouched = encode(changed) === core.share.signed;
                    expect(key).toBe(untouched ? core.share.nodeKey : null);
                },
            ),
            { numRuns: 60 },
        );
    });
});
