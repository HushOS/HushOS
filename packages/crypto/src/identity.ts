import { CryptoError } from './errors';
import sodium from 'libsodium-wrappers';
import { encryptKey, decryptKey } from './aead';
import { keyDigest } from './fingerprint';
import { encode, decode } from './keys';
import {
    KEM_SEED_BYTES,
    ML_DSA_PUBLIC_KEY_BYTES,
    ML_DSA_SEED_BYTES,
    kemKeypair,
    mlDsaKeypair,
} from './pq';
import {
    HYBRID_SIGNATURE_BYTES,
    keysStatement,
    signHybrid,
    successionConsentStatement,
    successionStatement,
    verifyHybrid,
    type HybridSigningKey,
    type SuccessionStatement,
} from './signatures';

/*
 * A person's identity (docs/identity-pq-design.md). Version 2, the only one
 * written, holds four key pairs, each private half wrapped under the account
 * root: X25519 and ML-KEM-768 to receive shares, Ed25519 and ML-DSA-65 to
 * sign. One statement, signed with both signing keys, binds the four public
 * keys to the account (keysStatement). Version 1 had no ML-DSA key and bound
 * its ML-KEM key with an Ed25519 signature alone; it is still read, because an
 * account upgrades from it on its next unlock and history rows keep it, but
 * nothing about it is trusted.
 */
export type IdentityKem = {
    publicKey: string;
    seedNonce: string;
    encryptedSeed: string;
    /* Version 1 only: the Ed25519 binding, no longer a path to trust. */
    signature?: string | null;
};

export type IdentityMlDsa = {
    publicKey: string;
    seedNonce: string;
    encryptedSeed: string;
};

/* The X25519 and Ed25519 halves, which every version has. */
type IdentityCommon = {
    keyVersion: number;
    wrappingSalt: string;
    encryptionPublicKey: string;
    encryptionPrivateKeyNonce: string;
    encryptedEncryptionPrivateKey: string;
    signingPublicKey: string;
    signingSeedNonce: string;
    encryptedSigningSeed: string;
};
/* Version 1: no ML-DSA key; an ML-KEM key with its Ed25519 binding, or none on the oldest. */
export type IdentityEnvelopeV1 = IdentityCommon & {
    version: 1;
    kem?: IdentityKem | null;
    mlDsa?: null;
    keysSignature?: null;
};
/* Version 2: all four halves and the keys statement's hybrid signature. */
export type IdentityEnvelopeV2 = IdentityCommon & {
    version: 2;
    kem: { publicKey: string; seedNonce: string; encryptedSeed: string };
    mlDsa: IdentityMlDsa;
    keysSignature: string;
};
export type IdentityEnvelope = IdentityEnvelopeV1 | IdentityEnvelopeV2;

const ML_DSA_PURPOSE = 'ml-dsa-seed-wrap';
const KEM_PURPOSE = 'kem-seed-wrap';

function checkEnvelope(envelope: IdentityEnvelope) {
    if (
        (envelope.version !== 1 && envelope.version !== 2) ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1 ||
        (envelope.version === 2 && (!envelope.kem || !envelope.mlDsa || !envelope.keysSignature))
    )
        throw new CryptoError('Unsupported identity envelope.');
}

/* A fresh seed of `bytes`, wrapped under the root for `purpose`, with the public key it expands to. */
async function mintSeed(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion: number,
    purpose: string,
) {
    const bytes = purpose === KEM_PURPOSE ? KEM_SEED_BYTES : ML_DSA_SEED_BYTES;
    const seed = crypto.getRandomValues(new Uint8Array(bytes));
    const pair = purpose === KEM_PURPOSE ? kemKeypair(seed) : mlDsaKeypair(seed);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const wrap = await identityWrappingKey(root, salt, purpose);
    const publicKey = encode(pair.publicKey);
    try {
        return {
            wrapped: {
                publicKey,
                seedNonce: encode(nonce),
                encryptedSeed: encode(
                    await encryptKey(
                        seed,
                        wrap,
                        nonce,
                        identityContext(userId, keyVersion, purpose, publicKey),
                    ),
                ),
            },
            secretKey: pair.secretKey,
        };
    } finally {
        seed.fill(0);
        wrap.fill(0);
    }
}

/*
 * Opens a wrapped lattice seed under the root and expands it, refusing a key
 * pair whose public key is not the one the envelope names. The caller owns
 * the secret key and zeroes it.
 */
async function openSeed(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion: number,
    purpose: string,
    wrapped: { publicKey: string; seedNonce: string; encryptedSeed: string },
) {
    const bytes = purpose === KEM_PURPOSE ? KEM_SEED_BYTES : ML_DSA_SEED_BYTES;
    const wrap = await identityWrappingKey(root, salt, purpose);
    let seed: Uint8Array | undefined;
    try {
        seed = await decryptKey(
            decode(wrapped.encryptedSeed, bytes + 16),
            wrap,
            decode(wrapped.seedNonce, 24),
            identityContext(userId, keyVersion, purpose, wrapped.publicKey),
        );
        const pair = purpose === KEM_PURPOSE ? kemKeypair(seed) : mlDsaKeypair(seed);
        if (encode(pair.publicKey) !== wrapped.publicKey) {
            pair.secretKey.fill(0);
            throw new CryptoError('Identity keys do not match.');
        }
        return pair.secretKey;
    } finally {
        wrap.fill(0);
        seed?.fill(0);
    }
}

/*
 * An ML-DSA key wrapped under the root, opened again before anything uses it:
 * a seed that does not open back to the same public key (a bug, wrong
 * associated data) must never be uploaded, since an identity whose signing key
 * cannot be opened can never sign again (docs/identity-pq-design.md 2).
 */
async function mintMlDsa(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion: number,
) {
    const minted = await mintSeed(root, salt, userId, keyVersion, ML_DSA_PURPOSE);
    try {
        const reopened = await openSeed(
            root,
            salt,
            userId,
            keyVersion,
            ML_DSA_PURPOSE,
            minted.wrapped,
        );
        reopened.fill(0);
    } catch (error) {
        minted.secretKey.fill(0);
        throw error;
    }
    return minted;
}

async function identityWrappingKey(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    purpose: string,
) {
    // The account root is 32 bytes, as the Rust core requires: an identity wrapped under any other
    // length would open on the web and nowhere else.
    if (!(root instanceof Uint8Array) || root.length !== 32)
        throw new CryptoError('Invalid account key.');
    const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt,
                info: new TextEncoder().encode(`hushos/identity/${purpose}/v1`),
            },
            key,
            256,
        ),
    );
}
function identityContext(userId: string, keyVersion: number, purpose: string, publicKey: string) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/identity',
            1,
            userId.toLowerCase(),
            keyVersion,
            purpose,
            publicKey,
        ]),
    );
}
/* The keys statement over a version 2 envelope's public keys, signed or checked. */
function keysOf(userId: string, envelope: Omit<IdentityEnvelopeV2, 'keysSignature'>) {
    return keysStatement({
        userId,
        keyVersion: envelope.keyVersion,
        encryptionPublicKey: envelope.encryptionPublicKey,
        signingPublicKey: envelope.signingPublicKey,
        mlDsaPublicKey: envelope.mlDsa.publicKey,
        kemPublicKey: envelope.kem.publicKey,
    });
}

/*
 * Whether a version 2 identity's keys statement holds: both halves of its
 * hybrid signature, under the Ed25519 and ML-DSA keys it names, over its four
 * public keys, its account and its key version. It proves the identity holds
 * both signing keys and ties the ML-KEM key to them; it is not by itself a
 * reason to trust anyone, which only a words check over the version 3
 * fingerprint is. Anything malformed, and any version 1 identity, is false.
 */
export async function verifyIdentityKeys(
    userId: string,
    identity: {
        keyVersion: number;
        encryptionPublicKey: string;
        signingPublicKey: string;
        mlDsaPublicKey: string;
        kemPublicKey: string;
        keysSignature: string;
    },
) {
    try {
        return await verifyHybrid(
            await keysStatement({ ...identity, userId }),
            decode(identity.keysSignature, HYBRID_SIGNATURE_BYTES),
            {
                signingPublicKey: decode(identity.signingPublicKey, 32),
                mlDsaPublicKey: decode(identity.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
            },
        );
    } catch {
        return false;
    }
}

/*
 * An independent long-lived identity, version 2, at `keyVersion`: four fresh
 * key pairs wrapped under the root and the keys statement signed with both
 * signing keys. Recovery rotates recovery credentials, never these keys.
 */
export async function createIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion = 1,
): Promise<IdentityEnvelopeV2> {
    await sodium.ready;
    const encryption = sodium.crypto_box_keypair();
    const signingSeed = crypto.getRandomValues(new Uint8Array(32));
    const signing = sodium.crypto_sign_seed_keypair(signingSeed);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const encryptionNonce = crypto.getRandomValues(new Uint8Array(24));
    const signingNonce = crypto.getRandomValues(new Uint8Array(24));
    const encryptionWrap = await identityWrappingKey(root, salt, 'encryption-private-wrap');
    const signingWrap = await identityWrappingKey(root, salt, 'signing-seed-wrap');
    const encryptionPublicKey = encode(encryption.publicKey);
    const signingPublicKey = encode(signing.publicKey);
    const secrets: Uint8Array[] = [
        encryption.privateKey,
        signing.privateKey,
        signingSeed,
        encryptionWrap,
        signingWrap,
    ];
    try {
        const kem = await mintSeed(root, salt, userId, keyVersion, KEM_PURPOSE);
        secrets.push(kem.secretKey);
        const mlDsa = await mintMlDsa(root, salt, userId, keyVersion);
        secrets.push(mlDsa.secretKey);
        const unsigned: Omit<IdentityEnvelopeV2, 'keysSignature'> = {
            version: 2,
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPublicKey,
            encryptionPrivateKeyNonce: encode(encryptionNonce),
            encryptedEncryptionPrivateKey: encode(
                await encryptKey(
                    encryption.privateKey,
                    encryptionWrap,
                    encryptionNonce,
                    identityContext(
                        userId,
                        keyVersion,
                        'encryption-private-wrap',
                        encryptionPublicKey,
                    ),
                ),
            ),
            signingPublicKey,
            signingSeedNonce: encode(signingNonce),
            encryptedSigningSeed: encode(
                await encryptKey(
                    signingSeed,
                    signingWrap,
                    signingNonce,
                    identityContext(userId, keyVersion, 'signing-seed-wrap', signingPublicKey),
                ),
            ),
            kem: kem.wrapped,
            mlDsa: mlDsa.wrapped,
        };
        const keysSignature = encode(
            await signHybrid(await keysOf(userId, unsigned), {
                signingKey: signing.privateKey,
                mlDsaSecretKey: mlDsa.secretKey,
            }),
        );
        return { ...unsigned, keysSignature };
    } finally {
        for (const secret of secrets) secret.fill(0);
    }
}

/*
 * The upgrade of a version 1 identity to version 2 (docs/identity-pq-design.md
 * 2): the same X25519, Ed25519 and ML-KEM keys and key version, plus a fresh
 * ML-DSA key (opened again before it is used, see mintMlDsa) and the keys
 * statement signed with both signing keys. A version 1 identity without an
 * ML-KEM key gets one here too. The Ed25519 KEM binding is dropped. Nothing is
 * installed: the server takes it or answers with the version 2 identity
 * another device uploaded first.
 */
export async function upgradeIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
): Promise<IdentityEnvelopeV2> {
    checkEnvelope(envelope);
    if (envelope.version !== 1) throw new CryptoError('This identity is already upgraded.');
    // Every key the statement will vouch for must open here first: an X25519 key the server
    // swapped in would otherwise be signed for by both of this person's signing keys.
    const encryptionKey = await openIdentityEncryptionKey(root, userId, envelope);
    const signingKey = await openIdentitySigningKey(root, userId, envelope);
    const salt = decode(envelope.wrappingSalt, 32);
    const secrets: Uint8Array[] = [encryptionKey, signingKey];
    try {
        let kem: IdentityEnvelopeV2['kem'];
        if (envelope.kem) {
            // Opened to prove the wrapped seed is this identity's before it is vouched for.
            secrets.push(
                await openSeed(root, salt, userId, envelope.keyVersion, KEM_PURPOSE, envelope.kem),
            );
            kem = {
                publicKey: envelope.kem.publicKey,
                seedNonce: envelope.kem.seedNonce,
                encryptedSeed: envelope.kem.encryptedSeed,
            };
        } else {
            const minted = await mintSeed(root, salt, userId, envelope.keyVersion, KEM_PURPOSE);
            secrets.push(minted.secretKey);
            kem = minted.wrapped;
        }
        const mlDsa = await mintMlDsa(root, salt, userId, envelope.keyVersion);
        secrets.push(mlDsa.secretKey);
        const upgraded: Omit<IdentityEnvelopeV2, 'keysSignature'> = {
            version: 2,
            keyVersion: envelope.keyVersion,
            wrappingSalt: envelope.wrappingSalt,
            encryptionPublicKey: envelope.encryptionPublicKey,
            encryptionPrivateKeyNonce: envelope.encryptionPrivateKeyNonce,
            encryptedEncryptionPrivateKey: envelope.encryptedEncryptionPrivateKey,
            signingPublicKey: envelope.signingPublicKey,
            signingSeedNonce: envelope.signingSeedNonce,
            encryptedSigningSeed: envelope.encryptedSigningSeed,
            kem,
            mlDsa: mlDsa.wrapped,
        };
        const keysSignature = encode(
            await signHybrid(await keysOf(userId, upgraded), {
                signingKey,
                mlDsaSecretKey: mlDsa.secretKey,
            }),
        );
        return { ...upgraded, keysSignature };
    } finally {
        for (const secret of secrets) secret.fill(0);
    }
}

/*
 * Rewraps the existing private keys under a new root; master-key rotation must
 * preserve public identity. The identity keeps its own key version: it numbers
 * the identity's generations (a succession adds one), not the root's
 * revisions, so a contact's pin and a succession chain survive a rotation.
 * Earlier identities in the account's history are rewrapped the same way. The
 * keys statement names no root, so it survives the rewrap.
 */
export async function rewrapIdentity(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
): Promise<IdentityEnvelope> {
    checkEnvelope(envelope);
    const keyVersion = envelope.keyVersion;
    await sodium.ready;
    const oldSalt = decode(envelope.wrappingSalt, 32);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const secrets: Uint8Array[] = [];
    async function rewrap(ciphertext: string, nonce: string, purpose: string, publicKey: string) {
        const oldWrap = await identityWrappingKey(oldRoot, oldSalt, purpose);
        secrets.push(oldWrap);
        const privateLength = purpose === KEM_PURPOSE ? KEM_SEED_BYTES : 32;
        const privateKey = await decryptKey(
            decode(ciphertext, privateLength + 16),
            oldWrap,
            decode(nonce, 24),
            identityContext(userId, keyVersion, purpose, publicKey),
        );
        secrets.push(privateKey);
        let derivedPublic: Uint8Array;
        if (purpose === 'encryption-private-wrap')
            derivedPublic = sodium.crypto_scalarmult_base(privateKey);
        else if (purpose === KEM_PURPOSE || purpose === ML_DSA_PURPOSE) {
            const pair =
                purpose === KEM_PURPOSE ? kemKeypair(privateKey) : mlDsaKeypair(privateKey);
            secrets.push(pair.secretKey);
            derivedPublic = pair.publicKey;
        } else {
            const pair = sodium.crypto_sign_seed_keypair(privateKey);
            secrets.push(pair.privateKey);
            derivedPublic = pair.publicKey;
        }
        if (encode(derivedPublic) !== publicKey)
            throw new CryptoError('Identity keys do not match.');
        const wrap = await identityWrappingKey(newRoot, salt, purpose);
        secrets.push(wrap);
        const nextNonce = crypto.getRandomValues(new Uint8Array(24));
        return {
            nonce: encode(nextNonce),
            encrypted: encode(
                await encryptKey(
                    privateKey,
                    wrap,
                    nextNonce,
                    identityContext(userId, keyVersion, purpose, publicKey),
                ),
            ),
        };
    }
    try {
        const encryption = await rewrap(
            envelope.encryptedEncryptionPrivateKey,
            envelope.encryptionPrivateKeyNonce,
            'encryption-private-wrap',
            envelope.encryptionPublicKey,
        );
        const signing = await rewrap(
            envelope.encryptedSigningSeed,
            envelope.signingSeedNonce,
            'signing-seed-wrap',
            envelope.signingPublicKey,
        );
        const kem = envelope.kem
            ? await rewrap(
                  envelope.kem.encryptedSeed,
                  envelope.kem.seedNonce,
                  KEM_PURPOSE,
                  envelope.kem.publicKey,
              )
            : null;
        const mlDsa = envelope.mlDsa
            ? await rewrap(
                  envelope.mlDsa.encryptedSeed,
                  envelope.mlDsa.seedNonce,
                  ML_DSA_PURPOSE,
                  envelope.mlDsa.publicKey,
              )
            : null;
        const common = {
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPublicKey: envelope.encryptionPublicKey,
            encryptionPrivateKeyNonce: encryption.nonce,
            encryptedEncryptionPrivateKey: encryption.encrypted,
            signingPublicKey: envelope.signingPublicKey,
            signingSeedNonce: signing.nonce,
            encryptedSigningSeed: signing.encrypted,
        };
        if (envelope.version === 2)
            return {
                ...common,
                version: 2,
                kem: { ...envelope.kem, seedNonce: kem!.nonce, encryptedSeed: kem!.encrypted },
                mlDsa: {
                    ...envelope.mlDsa,
                    seedNonce: mlDsa!.nonce,
                    encryptedSeed: mlDsa!.encrypted,
                },
                keysSignature: envelope.keysSignature,
            };
        return {
            ...common,
            version: 1,
            kem:
                envelope.kem && kem
                    ? { ...envelope.kem, seedNonce: kem.nonce, encryptedSeed: kem.encrypted }
                    : null,
        };
    } finally {
        for (const secret of secrets) secret.fill(0);
    }
}

/*
 * The identity's X25519 private key, opened under the account root: what seals
 * a share to a contact and opens one from them. Checked against the published
 * public key so a swapped envelope cannot put a stranger's key in the session.
 */
export async function openIdentityEncryptionKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    checkEnvelope(envelope);
    await sodium.ready;
    const wrap = await identityWrappingKey(
        root,
        decode(envelope.wrappingSalt, 32),
        'encryption-private-wrap',
    );
    try {
        const privateKey = await decryptKey(
            decode(envelope.encryptedEncryptionPrivateKey, 48),
            wrap,
            decode(envelope.encryptionPrivateKeyNonce, 24),
            identityContext(
                userId,
                envelope.keyVersion,
                'encryption-private-wrap',
                envelope.encryptionPublicKey,
            ),
        );
        if (encode(sodium.crypto_scalarmult_base(privateKey)) !== envelope.encryptionPublicKey) {
            privateKey.fill(0);
            throw new CryptoError('Identity keys do not match.');
        }
        return privateKey as Uint8Array<ArrayBuffer>;
    } finally {
        wrap.fill(0);
    }
}

/*
 * The identity's ML-KEM key pair, expanded from the seed under the account
 * root and checked against the published public key. Null for a version 1
 * identity made before hybrid sharing (its upgrade gives it one).
 */
export async function openIdentityKemKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    if (!envelope.kem) return null;
    checkEnvelope(envelope);
    const secretKey = await openSeed(
        root,
        decode(envelope.wrappingSalt, 32),
        userId,
        envelope.keyVersion,
        KEM_PURPOSE,
        envelope.kem,
    );
    return { publicKey: envelope.kem.publicKey, secretKey };
}

/*
 * The identity's ML-DSA-65 secret key, expanded from the seed under the
 * account root and checked against the published public key. Null for a
 * version 1 identity. The caller owns the key and zeroes it.
 */
export async function openIdentityMlDsaKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    if (!envelope.mlDsa) return null;
    checkEnvelope(envelope);
    const secretKey = await openSeed(
        root,
        decode(envelope.wrappingSalt, 32),
        userId,
        envelope.keyVersion,
        ML_DSA_PURPOSE,
        envelope.mlDsa,
    );
    return { publicKey: envelope.mlDsa.publicKey, secretKey };
}

/*
 * The identity's Ed25519 signing key (libsodium's 64-byte secret key), opened
 * under the root and proven to be the served signing public key's: its seed
 * opens with that key in the associated data and derives it. What signs every
 * file and folder write, and half of every hybrid signature. The caller owns
 * the key and zeroes it.
 */
export async function openIdentitySigningKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    checkEnvelope(envelope);
    await sodium.ready;
    const wrap = await identityWrappingKey(
        root,
        decode(envelope.wrappingSalt, 32),
        'signing-seed-wrap',
    );
    let seed: Uint8Array | undefined;
    try {
        seed = await decryptKey(
            decode(envelope.encryptedSigningSeed, 48),
            wrap,
            decode(envelope.signingSeedNonce, 24),
            identityContext(
                userId,
                envelope.keyVersion,
                'signing-seed-wrap',
                envelope.signingPublicKey,
            ),
        );
        const pair = sodium.crypto_sign_seed_keypair(seed);
        if (encode(pair.publicKey) !== envelope.signingPublicKey) {
            pair.privateKey.fill(0);
            throw new CryptoError('Identity keys do not match.');
        }
        return pair.privateKey as Uint8Array<ArrayBuffer>;
    } finally {
        wrap.fill(0);
        seed?.fill(0);
    }
}

/*
 * Proves the served public keys are this identity's own: every private half
 * opens under the root and derives its public key, and a version 2 identity's
 * keys statement holds. What the person's own fingerprint is computed from, so
 * a server cannot show them words over a key it swapped in.
 */
export async function verifyOwnIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    checkEnvelope(envelope);
    const secrets: Uint8Array[] = [];
    try {
        secrets.push(await openIdentityEncryptionKey(root, userId, envelope));
        secrets.push(await openIdentitySigningKey(root, userId, envelope));
        const kem = await openIdentityKemKey(root, userId, envelope);
        if (kem) secrets.push(kem.secretKey);
        const mlDsa = await openIdentityMlDsaKey(root, userId, envelope);
        if (mlDsa) secrets.push(mlDsa.secretKey);
        if (envelope.version === 2 && !(await verifyIdentityKeys(userId, publicIdentity(envelope))))
            throw new CryptoError('Identity keys do not match.');
    } finally {
        for (const secret of secrets) secret.fill(0);
    }
}

/* The public keys of a version 2 envelope, as the keys statement and contacts see them. */
export function publicIdentity(envelope: IdentityEnvelope) {
    if (envelope.version !== 2) throw new CryptoError('Unsupported identity envelope.');
    return {
        keyVersion: envelope.keyVersion,
        encryptionPublicKey: envelope.encryptionPublicKey,
        signingPublicKey: envelope.signingPublicKey,
        mlDsaPublicKey: envelope.mlDsa.publicKey,
        kemPublicKey: envelope.kem.publicKey,
        keysSignature: envelope.keysSignature,
    };
}

/* A link of a succession chain as the server serves it: the statement and the old identity's hybrid signature. */
/*
 * `signature` is the old identity's hybrid signature over the version 2
 * statement, what personal pins follow. `consent`, on links made from this
 * release on, is two hybrid signatures over the consent statement
 * (successionConsentStatement: its own domain, version 1, the role, then the
 * version 2 fields), the old identity's as "old" then the new identity's as
 * "new" (6746 bytes, base64url): the successor's consent, which the group core
 * asks of links from a member's first keys up to their entry's keys.
 */
export type SuccessionLink = Omit<SuccessionStatement, 'userId'> & {
    signature: string;
    consent?: string | null;
};

/* The size of a link's consent: two hybrid signatures, the old identity's and the new one's. */
export const SUCCESSION_CONSENT_BYTES = 2 * HYBRID_SIGNATURE_BYTES;
/*
 * The keys a contact was pinned with, from a version 3 pin: the X25519 and
 * Ed25519 keys and the ML-DSA key's SHA-256 (hex), and the key version the pin
 * was made at. The keys the server serves for them now, in full.
 */
export type PinnedKeys = {
    keyVersion: number | null;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyHash: string;
};
export type ServedKeys = {
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string;
    kemPublicKey: string;
};

/*
 * A new identity for the account at the next key version, vouched for by the
 * current one: four fresh key pairs wrapped under the root, and the version 2
 * succession statement signed with the current identity's hybrid signature
 * (the caller's keys, proven against `current`). Nothing is installed: the
 * server takes it or refuses it, and only then does the device open it.
 */
export async function createSuccessor(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    current: IdentityEnvelope,
    keys: HybridSigningKey,
) {
    checkEnvelope(current);
    if (current.version !== 2) throw new CryptoError('Upgrade this identity first.');
    await sodium.ready;
    if (
        keys.signingKey.length !== 64 ||
        encode(keys.signingKey.subarray(32)) !== current.signingPublicKey
    )
        throw new CryptoError('Identity keys do not match.');
    const identity = await createIdentity(root, userId, current.keyVersion + 1);
    if (identity.version !== 2) throw new CryptoError('Unsupported identity envelope.');
    const fields = {
        userId,
        oldKeyVersion: current.keyVersion,
        newKeyVersion: identity.keyVersion,
        oldEncryptionPublicKey: current.encryptionPublicKey,
        oldSigningPublicKey: current.signingPublicKey,
        oldMlDsaPublicKey: current.mlDsa.publicKey,
        newEncryptionPublicKey: identity.encryptionPublicKey,
        newSigningPublicKey: identity.signingPublicKey,
        newMlDsaPublicKey: identity.mlDsa.publicKey,
        newKemPublicKey: identity.kem.publicKey,
    };
    const signature = await signHybrid(await successionStatement(fields), keys);
    // The successor consents: the old identity signs the consent statement as "old", the new one
    // as "new".
    const next = {
        signingKey: await openIdentitySigningKey(root, userId, identity),
        mlDsaSecretKey: (await openIdentityMlDsaKey(root, userId, identity))!.secretKey,
    };
    try {
        const consent = new Uint8Array(SUCCESSION_CONSENT_BYTES);
        consent.set(await signHybrid(await successionConsentStatement(fields, 'old'), keys));
        consent.set(
            await signHybrid(await successionConsentStatement(fields, 'new'), next),
            HYBRID_SIGNATURE_BYTES,
        );
        return { identity, signature: encode(signature), consent: encode(consent) };
    } finally {
        next.signingKey.fill(0);
        next.mlDsaSecretKey.fill(0);
    }
}

/*
 * Whether a link carries its successor's consent: the consent statement
 * signed, both halves each, by the old keys as "old" and by the new keys the
 * link itself names as "new". What the group core asks of links into keys it
 * reached from a member's first keys (planted keys can sign a link away from
 * themselves, never the member's consent to it); everywhere else, and for
 * personal pins (verifySuccessionChain), the version 2 signature holds.
 */
export async function verifySuccessionConsent(userId: string, link: SuccessionLink) {
    try {
        if (typeof link.consent !== 'string') return false;
        const consent = decode(link.consent, SUCCESSION_CONSENT_BYTES);
        const fields = { ...link, userId };
        const under = (signing: string, mlDsa: string) => ({
            signingPublicKey: decode(signing, 32),
            mlDsaPublicKey: decode(mlDsa, ML_DSA_PUBLIC_KEY_BYTES),
        });
        return (
            (await verifyHybrid(
                await successionConsentStatement(fields, 'old'),
                consent.subarray(0, HYBRID_SIGNATURE_BYTES),
                under(link.oldSigningPublicKey, link.oldMlDsaPublicKey),
            )) &&
            (await verifyHybrid(
                await successionConsentStatement(fields, 'new'),
                consent.subarray(HYBRID_SIGNATURE_BYTES),
                under(link.newSigningPublicKey, link.newMlDsaPublicKey),
            ))
        );
    } catch {
        return false;
    }
}

/*
 * Whether one link holds: its version 2 statement, signed with both halves of
 * the hybrid signature under `signer`, the keys the reader already trusts for
 * that position in the chain (the pinned ones, or the previous link's new
 * ones). Never under keys only the link itself names.
 */
export async function verifySuccessionLink(
    userId: string,
    link: SuccessionLink,
    signer: { signingPublicKey: string; mlDsaPublicKey: string },
) {
    try {
        return await verifyHybrid(
            await successionStatement({ ...link, userId }),
            decode(link.signature, HYBRID_SIGNATURE_BYTES),
            {
                signingPublicKey: decode(signer.signingPublicKey, 32),
                mlDsaPublicKey: decode(signer.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
            },
        );
    } catch {
        return false;
    }
}

/*
 * Whether `links` carry a contact from the keys pinned to the keys served
 * (docs/identity-pq-design.md 2). Continuity is by keys, not version numbers
 * (a master-key rotation may raise an identity's version between two
 * successions):
 * - the chain starts only at a link whose old X25519, Ed25519 and ML-DSA keys
 *   are the pin's (the ML-DSA key by its digest);
 * - each link's old keys are the previous link's new keys, ML-DSA included,
 *   and versions only rise;
 * - each signature verifies, both halves, under the pinned keys or the
 *   previous link's new keys;
 * - the last link's new X25519, Ed25519, ML-DSA and ML-KEM keys are the served
 *   ones.
 * The chain is every link from the first one at the pin to the end of the
 * list, in the order served: links before it are skipped, but a link after
 * the chain's end, or the links out of order, and it does not hold. Any gap,
 * fork or bad signature and the chain does not hold; that is the changed-key
 * warning, never a silent update. (The group core does not use this verifier:
 * it walks the verified links as a graph, succession-path.ts.)
 */
export async function verifySuccessionChain(
    userId: string,
    pinned: PinnedKeys,
    served: ServedKeys,
    links: SuccessionLink[],
) {
    let start = -1;
    for (let index = 0; index < links.length; index++) {
        const link = links[index]!;
        if (
            link.oldEncryptionPublicKey === pinned.encryptionPublicKey &&
            link.oldSigningPublicKey === pinned.signingPublicKey &&
            (await mlDsaDigestOf(link.oldMlDsaPublicKey)) === pinned.mlDsaPublicKeyHash
        ) {
            start = index;
            break;
        }
    }
    if (start < 0) return false;
    const chain = links.slice(start);
    let at = {
        keyVersion: pinned.keyVersion ?? 0,
        encryptionPublicKey: pinned.encryptionPublicKey,
        signingPublicKey: pinned.signingPublicKey,
        // The first link's old ML-DSA key, matched to the pin by digest above.
        mlDsaPublicKey: chain[0]!.oldMlDsaPublicKey,
        kemPublicKey: null as string | null,
    };
    for (const link of chain) {
        if (
            link.oldKeyVersion < at.keyVersion ||
            link.oldEncryptionPublicKey !== at.encryptionPublicKey ||
            link.oldSigningPublicKey !== at.signingPublicKey ||
            link.oldMlDsaPublicKey !== at.mlDsaPublicKey ||
            !(await verifySuccessionLink(userId, link, at))
        )
            return false;
        at = {
            keyVersion: link.newKeyVersion,
            encryptionPublicKey: link.newEncryptionPublicKey,
            signingPublicKey: link.newSigningPublicKey,
            mlDsaPublicKey: link.newMlDsaPublicKey,
            kemPublicKey: link.newKemPublicKey,
        };
    }
    return (
        served.keyVersion >= at.keyVersion &&
        at.encryptionPublicKey === served.encryptionPublicKey &&
        at.signingPublicKey === served.signingPublicKey &&
        at.mlDsaPublicKey === served.mlDsaPublicKey &&
        at.kemPublicKey === served.kemPublicKey
    );
}

/* SHA-256 of a base64url ML-DSA public key, as hex; null when it is not one. */
async function mlDsaDigestOf(publicKey: string) {
    try {
        return await keyDigest(decode(publicKey, ML_DSA_PUBLIC_KEY_BYTES));
    } catch {
        return null;
    }
}
