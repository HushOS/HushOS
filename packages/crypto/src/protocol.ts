export const OPAQUE_PROFILE_VERSION = 1;
export const ENVELOPE_VERSION = 1;
export const OPAQUE_IDENTIFIERS = { server: 'hushos/opaque/profile/1' };
export const KEY_STRETCHING = {
    'argon2id-custom': { memory: 65_536, iterations: 3, parallelism: 4 },
};

export type AccountKeyEnvelope = {
    envelopeVersion: number;
    keyVersion: number;
    credentialVersion: number;
    wrappingSalt: string;
    wrappingNonce: string;
    encryptedKey: string;
};

export function accountKeyContext(userId: string, keyVersion: number, credentialVersion: number) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/account-key/password-wrap',
            ENVELOPE_VERSION,
            userId.toLowerCase(),
            keyVersion,
            credentialVersion,
        ]),
    );
}

export const PASSWORD_WRAPPING_CONTEXT = 'hushos/account-key/password-wrap/v1';
