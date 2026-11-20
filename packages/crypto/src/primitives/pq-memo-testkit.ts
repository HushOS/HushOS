import { createHash } from 'node:crypto';
import type * as Pq from './pq';

/*
 * ML-DSA verification remembered, for the fixture tests that run whole
 * histories through the worker case after case: one check of the core's
 * settings areas verified 2,018 signatures, 91 of them distinct, and pure
 * JavaScript ML-DSA spent five of its seven seconds there. Verification is a
 * pure function, so each distinct (signature, message, key, context) is
 * verified once, for real, and its answer handed back after: nothing passes
 * here that would not pass without it. Signing is left alone.
 *
 * Use it in a test file as
 *     vi.mock('./pq', async (original) =>
 *         (await import('./pq-memo-testkit')).verifyOnce(await original<typeof Pq>()),
 *     );
 */
export function verifyOnce(pq: typeof Pq): typeof Pq {
    const verdicts = new Map<string, boolean>();
    return {
        ...pq,
        mlDsaVerify: (signature, message, publicKey, context) => {
            const hash = createHash('sha256');
            for (const part of [signature, message, publicKey]) {
                hash.update(String(part.length)).update(':').update(part);
            }
            const key = hash.update(context).digest('base64');
            let verdict = verdicts.get(key);
            if (verdict === undefined) {
                verdict = pq.mlDsaVerify(signature, message, publicKey, context);
                verdicts.set(key, verdict);
            }
            return verdict;
        },
    };
}
