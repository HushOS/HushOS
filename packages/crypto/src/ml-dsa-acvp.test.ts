import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { describe, expect, test } from 'vitest';
import { mlDsaKeypair } from './pq';
import acvp from '../../../crates/hushos-core/fixtures/ml-dsa-65-acvp.json';

/*
 * FIPS 204 ACVP vectors for ML-DSA-65 (usnistgov/ACVP-Server, a subset; the
 * fixture names the commit and files). The Rust core checks the same file in
 * crates/hushos-core/src/pq.rs: both implementations must pass every case
 * before either library is upgraded (docs/identity-pq-design.md 1).
 */
const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

describe('ML-DSA-65 ACVP', () => {
    test('key generation from ξ gives the published public and secret keys', () => {
        expect(acvp.keyGen).toHaveLength(5);
        for (const vector of acvp.keyGen) {
            const { publicKey, secretKey } = mlDsaKeypair(hex(vector.seed));
            expect(publicKey, `tcId ${vector.tcId}`).toEqual(hex(vector.pk));
            expect(secretKey, `tcId ${vector.tcId}`).toEqual(hex(vector.sk));
        }
    });

    test('signing with a context gives the published signatures, deterministic and with the given rnd', () => {
        expect(acvp.sigGen.some((vector) => !vector.deterministic)).toBe(true);
        for (const vector of acvp.sigGen) {
            const context = hex(vector.context);
            const message = hex(vector.message);
            const signature = ml_dsa65.sign(message, hex(vector.sk), {
                context,
                extraEntropy: vector.deterministic ? false : hex(vector.rnd!),
            });
            expect(signature, `tcId ${vector.tcId}`).toEqual(hex(vector.signature));
            expect(ml_dsa65.verify(signature, message, hex(vector.pk), { context })).toBe(true);
        }
    });

    test('verification accepts the valid signatures and refuses every modification, malformed hints included', () => {
        expect(acvp.sigVer.filter((vector) => vector.reason.includes('hint')).length).toBe(3);
        expect(acvp.sigVer.some((vector) => vector.testPassed)).toBe(true);
        for (const vector of acvp.sigVer) {
            let valid: boolean;
            try {
                valid = ml_dsa65.verify(
                    hex(vector.signature),
                    hex(vector.message),
                    hex(vector.pk),
                    { context: hex(vector.context) },
                );
            } catch {
                valid = false;
            }
            expect(valid, `tcId ${vector.tcId}: ${vector.reason}`).toBe(vector.testPassed);
        }
    });
});
