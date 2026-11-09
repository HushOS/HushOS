import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decode, encode } from './keys';
import { recoverySigningKey } from './recovery';

/*
 * Two-step sign-in, the part a device signs (docs/two-step-design.md 5): the
 * recovery phrase answering the second step. The phrase never leaves the
 * device. It derives the recovery signing key, from the phrase and the salt the
 * step response carries, and signs
 *
 *     ["hushos/two-step/phrase",1,userId,sha256(stepToken)]
 *
 * where the digest is SHA-256 of the step token's UTF-8 bytes, base64url. The
 * server checks the signature against the account's stored recovery public
 * key. A step token passes once, so a signature is good for one step, and one
 * made for another token, another account or under another phrase verifies
 * nothing. `crates/hushos-core` builds the same bytes; the fixture
 * `crates/hushos-core/fixtures/web-two-step.json` holds the two to each other
 * (scripts/two-step-fixtures.ts writes it, two-step.test.ts pins it).
 */

const PHRASE_DOMAIN = 'hushos/two-step/phrase';

/* The digest a phrase statement names: SHA-256 of the step token's bytes, base64url. */
export async function stepTokenDigest(stepToken: string) {
    return encode(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stepToken))),
    );
}

/* An empty account or token is refused: no step names one, so a statement over one proves nothing. */
export async function twoStepPhraseStatement(input: { userId: string; stepToken: string }) {
    if (!input.userId || !input.stepToken) throw new CryptoError('Invalid two-step statement.');
    return new TextEncoder().encode(
        JSON.stringify([
            PHRASE_DOMAIN,
            1,
            input.userId.toLowerCase(),
            await stepTokenDigest(input.stepToken),
        ]),
    );
}

/*
 * The phrase's answer to a step: the signature over its statement, base64url
 * (64 bytes). `wrappingSalt` is the recovery envelope's, as the step response
 * gives it (`phrase.wrappingSalt`). A phrase that is not a phrase is a
 * CryptoError; one that is simply not this account's signs something the
 * server refuses, as a wrong code is refused.
 */
export async function signTwoStepPhrase(
    phrase: string,
    input: { userId: string; stepToken: string; wrappingSalt: string },
) {
    const statement = await twoStepPhraseStatement(input);
    const { privateKey } = await recoverySigningKey(phrase, input.wrappingSalt);
    try {
        return encode(sodium.crypto_sign_detached(statement, privateKey));
    } finally {
        privateKey.fill(0);
    }
}

/*
 * Whether `signature` is the recovery key's over this account's statement for
 * this step token. Anything malformed is false, never an error: a wrong answer
 * to the step is counted, not thrown.
 */
export async function verifyTwoStepPhrase(
    input: { userId: string; stepToken: string },
    signature: string,
    publicKey: string,
) {
    await sodium.ready;
    try {
        return sodium.crypto_sign_verify_detached(
            decode(signature, 64),
            await twoStepPhraseStatement(input),
            decode(publicKey, 32),
        );
    } catch {
        return false;
    }
}
