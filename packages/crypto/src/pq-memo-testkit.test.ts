import { expect, test } from 'vitest';
import * as pq from './pq';
import { verifyOnce } from './pq-memo-testkit';

/* The fixture tests trust verifyOnce to answer as ML-DSA does; any input it confused would let a forgery pass there. */
test('a remembered verdict is never handed to another signature, message, key or context', () => {
    const memo = verifyOnce(pq);
    const signer = pq.mlDsaKeypair(new Uint8Array(32).fill(1));
    const other = pq.mlDsaKeypair(new Uint8Array(32).fill(2));
    const message = new TextEncoder().encode('roster 3');
    const signature = pq.mlDsaSign(message, signer.secretKey, 'ctx');
    expect(memo.mlDsaVerify(signature, message, signer.publicKey, 'ctx')).toBe(true);
    const tampered = signature.slice();
    tampered[100]! ^= 1;
    expect(memo.mlDsaVerify(tampered, message, signer.publicKey, 'ctx')).toBe(false);
    expect(
        memo.mlDsaVerify(signature, new TextEncoder().encode('roster 4'), signer.publicKey, 'ctx'),
    ).toBe(false);
    expect(memo.mlDsaVerify(signature, message, other.publicKey, 'ctx')).toBe(false);
    expect(memo.mlDsaVerify(signature, message, signer.publicKey, 'ctx2')).toBe(false);
    // And the honest one still holds after the refusals around it.
    expect(memo.mlDsaVerify(signature, message, signer.publicKey, 'ctx')).toBe(true);
});
