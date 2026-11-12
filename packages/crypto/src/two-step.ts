import sodium from 'libsodium-wrappers';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * Two-step sign-in, the parts a client and the server both build
 * (docs/two-step-design.md 2, 5): the statement the recovery phrase signs to pass the step,
 * and how a typed backup code is read.
 *
 * The phrase passes the step without leaving the device. The device derives the recovery
 * signing key from the phrase and the recovery envelope's salt, as a phrase reset does
 * (recovery.ts), and signs
 *
 *     ["hushos/two-step/phrase",1,userId,sha256(stepToken)]
 *
 * where the digest is SHA-256 of the step token's UTF-8 bytes, base64url. That digest is what
 * the server keeps of the token, so it rebuilds the statement from its own row; and a token
 * is used once, so a signature is good for one step. `crates/hushos-core` builds the same
 * bytes when the phone apps answer the step.
 */

const DOMAIN = 'hushos/two-step/phrase';

async function sha256(bytes: Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
}

/* The digest a phrase statement names: SHA-256 of the step token's bytes, base64url. */
export async function stepTokenDigest(stepToken: string) {
    return encode(await sha256(new TextEncoder().encode(stepToken)));
}

/* An empty account or token is refused: no step names one, so a statement over one proves nothing. */
export function twoStepPhraseStatement(input: { userId: string; tokenDigest: string }) {
    if (!input.userId || decode(input.tokenDigest, 32).length !== 32)
        throw new CryptoError('Invalid two-step statement.');
    return new TextEncoder().encode(
        JSON.stringify([DOMAIN, 1, input.userId.toLowerCase(), input.tokenDigest]),
    );
}

/*
 * The recovery signing key, from the phrase and the salt the step's response carries. Nothing
 * here says whether the phrase is the account's: the server's check of the signature does.
 */
export async function recoveryStepKey(phrase: string, wrappingSalt: string) {
    await sodium.ready;
    let secret: Uint8Array<ArrayBuffer>;
    try {
        secret = new Uint8Array(
            mnemonicToEntropy(phrase.trim().toLowerCase().split(/\s+/).join(' '), wordlist),
        );
    } catch {
        throw new CryptoError(
            'That is not a valid recovery phrase. Check each word and try again.',
        );
    }
    if (secret.length !== 32) {
        secret.fill(0);
        throw new CryptoError('Enter your 24-word recovery phrase.');
    }
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const seed = new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: decode(wrappingSalt, 32),
                // The recovery signing key's own derivation (recovery.ts, `authentication`).
                info: new TextEncoder().encode('hushos/recovery/authentication/v1'),
            },
            key,
            256,
        ),
    );
    try {
        return new Uint8Array(sodium.crypto_sign_seed_keypair(seed).privateKey);
    } finally {
        secret.fill(0);
        seed.fill(0);
    }
}

/* The phrase's answer to a step: the signature over its statement, base64url (64 bytes). */
export async function signTwoStepPhrase(
    signingKey: Uint8Array,
    input: { userId: string; stepToken: string },
) {
    await sodium.ready;
    const statement = twoStepPhraseStatement({
        userId: input.userId,
        tokenDigest: await stepTokenDigest(input.stepToken),
    });
    return encode(sodium.crypto_sign_detached(statement, signingKey));
}

/* Whether `signature` is the recovery key's over this account's statement for this token. */
export async function verifyTwoStepPhrase(
    input: { userId: string; tokenDigest: string },
    signature: string,
    publicKey: string,
) {
    await sodium.ready;
    try {
        return sodium.crypto_sign_verify_detached(
            decode(signature, 64),
            twoStepPhraseStatement(input),
            decode(publicKey, 32),
        );
    } catch {
        return false;
    }
}

/*
 * Backup codes: ten characters of Crockford base32 (no I, L, O or U), 50 bits, shown as
 * `7KQ2M-9XD4P`. What a person types is read forgivingly: case, spaces and hyphens are
 * ignored, I and L read as 1 and O as 0. Anything else is not a code (null).
 */
export const BACKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BACKUP_CODE_LENGTH = 10;

export function normalizeBackupCode(typed: string) {
    const code = typed
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replaceAll('O', '0');
    if (code.length !== BACKUP_CODE_LENGTH) return null;
    for (const character of code) if (!BACKUP_CODE_ALPHABET.includes(character)) return null;
    return code;
}

/* A code as it is shown: two groups of five. */
export function formatBackupCode(code: string) {
    return `${code.slice(0, 5)}-${code.slice(5)}`;
}
