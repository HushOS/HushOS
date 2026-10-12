import { CryptoError } from './errors';
import sodium from 'libsodium-wrappers';
import { encryptKey, decryptKey } from './aead';
import { encode, decode } from './keys';
import { KEM_PUBLIC_KEY_BYTES, KEM_SEED_BYTES, kemKeypair } from './pq';
import {
    signStatement,
    successionStatement,
    verifyStatement,
    type SuccessionStatement,
} from './signatures';

/*
 * The post-quantum half of the identity: an ML-KEM-768 key pair, its seed
 * wrapped under the account root beside the X25519 key and the signing seed,
 * and a signature by the identity's Ed25519 key binding the public key to this
 * identity. The signature is what lets a contact accept the key on the strength
 * of the fingerprint they compared: the fingerprint covers the X25519 key and
 * the signing key, the signing key vouches for the KEM key, and a server that
 * swapped the KEM key could not produce the signature.
 */
export type IdentityKem = {
    publicKey: string;
    seedNonce: string;
    encryptedSeed: string;
    signature: string;
};

export type IdentityEnvelope = {
    version: 1;
    keyVersion: number;
    wrappingSalt: string;
    encryptionPublicKey: string;
    encryptionPrivateKeyNonce: string;
    encryptedEncryptionPrivateKey: string;
    signingPublicKey: string;
    signingSeedNonce: string;
    encryptedSigningSeed: string;
    /* Absent on identities made before hybrid sharing; minted on the next unlock. */
    kem?: IdentityKem | null;
};

/* What the identity's signing key signs to vouch for its KEM key. */
export function kemBinding(userId: string, encryptionPublicKey: string, kemPublicKey: string) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/identity/kem',
            1,
            userId.toLowerCase(),
            encryptionPublicKey,
            kemPublicKey,
        ]),
    );
}

/* Whether `kem` belongs to the identity whose X25519 and signing keys these are. */
export async function verifyKemBinding(
    userId: string,
    encryptionPublicKey: string,
    signingPublicKey: string,
    kem: { publicKey: string; signature: string },
) {
    await sodium.ready;
    try {
        decode(kem.publicKey, KEM_PUBLIC_KEY_BYTES);
        return sodium.crypto_sign_verify_detached(
            decode(kem.signature, 64),
            kemBinding(userId, encryptionPublicKey, kem.publicKey),
            decode(signingPublicKey, 32),
        );
    } catch {
        return false;
    }
}

/* Mints a KEM key pair, wraps its seed under the root, and signs the binding. Wipes what it opens. */
async function mintKem(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion: number,
    encryptionPublicKey: string,
    signingPrivateKey: Uint8Array,
): Promise<IdentityKem> {
    const seed = crypto.getRandomValues(new Uint8Array(KEM_SEED_BYTES));
    const pair = kemKeypair(seed);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const wrap = await identityWrappingKey(root, salt, 'kem-seed-wrap');
    const publicKey = encode(pair.publicKey);
    try {
        return {
            publicKey,
            seedNonce: encode(nonce),
            encryptedSeed: encode(
                await encryptKey(
                    seed,
                    wrap,
                    nonce,
                    identityContext(userId, keyVersion, 'kem-seed-wrap', publicKey),
                ),
            ),
            signature: encode(
                sodium.crypto_sign_detached(
                    kemBinding(userId, encryptionPublicKey, publicKey),
                    signingPrivateKey,
                ),
            ),
        };
    } finally {
        seed.fill(0);
        pair.secretKey.fill(0);
        wrap.fill(0);
    }
}
async function identityWrappingKey(
    root: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    purpose: string,
) {
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
// Independent long-lived identity. Recovery rotates recovery credentials, never these keys.
export async function createIdentity(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    keyVersion = 1,
): Promise<IdentityEnvelope> {
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
    try {
        return {
            version: 1,
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPublicKey,
            signingPublicKey,
            kem: await mintKem(
                root,
                salt,
                userId,
                keyVersion,
                encryptionPublicKey,
                signing.privateKey,
            ),
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
            signingSeedNonce: encode(signingNonce),
            encryptedSigningSeed: encode(
                await encryptKey(
                    signingSeed,
                    signingWrap,
                    signingNonce,
                    identityContext(userId, keyVersion, 'signing-seed-wrap', signingPublicKey),
                ),
            ),
        };
    } finally {
        encryption.privateKey.fill(0);
        signing.privateKey.fill(0);
        signingSeed.fill(0);
        encryptionWrap.fill(0);
        signingWrap.fill(0);
    }
}

/*
 * Rewraps the existing private keys under a new root; master-key rotation must
 * preserve public identity. The identity keeps its own key version: it numbers
 * the identity's generations (a succession adds one), not the root's
 * revisions, so a contact's pin and a succession chain survive a rotation.
 * Earlier identities in the account's history are rewrapped the same way.
 */
export async function rewrapIdentity(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
): Promise<IdentityEnvelope> {
    const keyVersion = envelope.keyVersion;
    if (
        envelope.version !== 1 ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1
    )
        throw new CryptoError('Unsupported identity envelope.');
    await sodium.ready;
    const oldSalt = decode(envelope.wrappingSalt, 32);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const secrets: Uint8Array[] = [];
    async function rewrap(ciphertext: string, nonce: string, purpose: string, publicKey: string) {
        const oldWrap = await identityWrappingKey(oldRoot, oldSalt, purpose);
        secrets.push(oldWrap);
        const privateKey = await decryptKey(
            decode(ciphertext, purpose === 'kem-seed-wrap' ? KEM_SEED_BYTES + 16 : 48),
            oldWrap,
            decode(nonce, 24),
            identityContext(userId, envelope.keyVersion, purpose, publicKey),
        );
        secrets.push(privateKey);
        const derivedPublic =
            purpose === 'encryption-private-wrap'
                ? sodium.crypto_scalarmult_base(privateKey)
                : purpose === 'kem-seed-wrap'
                  ? (() => {
                        const pair = kemKeypair(privateKey);
                        secrets.push(pair.secretKey);
                        return pair.publicKey;
                    })()
                  : (() => {
                        const pair = sodium.crypto_sign_seed_keypair(privateKey);
                        secrets.push(pair.privateKey);
                        return pair.publicKey;
                    })();
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
                  'kem-seed-wrap',
                  envelope.kem.publicKey,
              )
            : null;
        return {
            ...envelope,
            keyVersion,
            wrappingSalt: encode(salt),
            encryptionPrivateKeyNonce: encryption.nonce,
            encryptedEncryptionPrivateKey: encryption.encrypted,
            signingSeedNonce: signing.nonce,
            encryptedSigningSeed: signing.encrypted,
            // The binding signature names no key version, so it survives the rewrap.
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
 * a share to a contact and opens one from them, and what the settings key is
 * derived from. Checked against the published public key so a swapped
 * envelope cannot put a stranger's key in the session.
 */
export async function openIdentityEncryptionKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    if (
        envelope.version !== 1 ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1
    )
        throw new CryptoError('Unsupported identity envelope.');
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
 * root and checked against the published public key. Null for an identity made
 * before hybrid sharing, until `addIdentityKem` gives it one.
 */
export async function openIdentityKemKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    if (!envelope.kem) return null;
    const wrap = await identityWrappingKey(
        root,
        decode(envelope.wrappingSalt, 32),
        'kem-seed-wrap',
    );
    let seed: Uint8Array | undefined;
    try {
        seed = await decryptKey(
            decode(envelope.kem.encryptedSeed, KEM_SEED_BYTES + 16),
            wrap,
            decode(envelope.kem.seedNonce, 24),
            identityContext(userId, envelope.keyVersion, 'kem-seed-wrap', envelope.kem.publicKey),
        );
        const pair = kemKeypair(seed);
        if (encode(pair.publicKey) !== envelope.kem.publicKey) {
            pair.secretKey.fill(0);
            throw new CryptoError('Identity keys do not match.');
        }
        return { publicKey: envelope.kem.publicKey, secretKey: pair.secretKey };
    } finally {
        wrap.fill(0);
        seed?.fill(0);
    }
}

/*
 * The identity's Ed25519 signing key (libsodium's 64-byte secret key), opened
 * under the root and proven to be the served signing public key's: its seed
 * opens with that key in the associated data and derives it. What signs every
 * write, a share and a succession. The caller owns the key and zeroes it.
 */
export async function openIdentitySigningKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    if (envelope.version !== 1) throw new CryptoError('Unsupported identity envelope.');
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
 * Proves the served signing public key is this identity's own (see
 * openIdentitySigningKey). What the person's own fingerprint is computed
 * from, so a server cannot show them a fingerprint over a signing key it
 * swapped in.
 */
export async function verifyIdentitySigningKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
) {
    (await openIdentitySigningKey(root, userId, envelope)).fill(0);
    return envelope.signingPublicKey;
}

/*
 * Gives an identity made before hybrid sharing its KEM key: the signing seed is
 * opened under the root to sign the binding, and the rest is as at creation.
 * The X25519 and signing keys, and so the fingerprint, do not change.
 */
export async function addIdentityKem(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: IdentityEnvelope,
): Promise<IdentityKem> {
    if (envelope.version !== 1 || envelope.kem)
        throw new CryptoError('Unsupported identity envelope.');
    await sodium.ready;
    const salt = decode(envelope.wrappingSalt, 32);
    const wrap = await identityWrappingKey(root, salt, 'signing-seed-wrap');
    let seed: Uint8Array | undefined;
    let pair: { publicKey: Uint8Array; privateKey: Uint8Array } | undefined;
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
        pair = sodium.crypto_sign_seed_keypair(seed);
        if (encode(pair.publicKey) !== envelope.signingPublicKey)
            throw new CryptoError('Identity keys do not match.');
        return await mintKem(
            root,
            salt,
            userId,
            envelope.keyVersion,
            envelope.encryptionPublicKey,
            pair.privateKey,
        );
    } finally {
        wrap.fill(0);
        seed?.fill(0);
        pair?.privateKey.fill(0);
    }
}

/* A link of a succession chain as the server serves it: the statement and the old key's signature. */
export type SuccessionLink = Omit<SuccessionStatement, 'userId'> & { signature: string };
/*
 * The keys a contact was pinned with (a pin made before successions records no
 * key version: null), and the keys the server serves for them now.
 */
export type PinnedKeys = {
    keyVersion: number | null;
    encryptionPublicKey: string;
    signingPublicKey: string;
};
export type ServedKeys = {
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    kemPublicKey: string;
};

/*
 * A new identity for the account at the next key version, vouched for by the
 * current one: fresh X25519, Ed25519 and ML-KEM keys wrapped under the root,
 * and the succession statement signed with the current signing key (the
 * caller's, proven against `current`). Nothing is installed: the server takes
 * it or refuses it, and only then does the device open it.
 */
export async function createSuccessor(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    current: IdentityEnvelope,
    signingKey: Uint8Array,
) {
    if (
        current.version !== 1 ||
        !Number.isSafeInteger(current.keyVersion) ||
        current.keyVersion < 1
    )
        throw new CryptoError('Unsupported identity envelope.');
    await sodium.ready;
    if (signingKey.length !== 64 || encode(signingKey.subarray(32)) !== current.signingPublicKey)
        throw new CryptoError('Identity keys do not match.');
    const identity = await createIdentity(root, userId, current.keyVersion + 1);
    const statement = await successionStatement({
        userId,
        oldKeyVersion: current.keyVersion,
        newKeyVersion: identity.keyVersion,
        oldEncryptionPublicKey: current.encryptionPublicKey,
        oldSigningPublicKey: current.signingPublicKey,
        newEncryptionPublicKey: identity.encryptionPublicKey,
        newSigningPublicKey: identity.signingPublicKey,
        newKemPublicKey: identity.kem!.publicKey,
    });
    return { identity, signature: encode(await signStatement(statement, signingKey)) };
}

/* Whether one link holds: its statement signed by the old signing key it names. */
export async function verifySuccessionLink(userId: string, link: SuccessionLink) {
    try {
        return await verifyStatement(
            await successionStatement({ ...link, userId }),
            decode(link.signature, 64),
            decode(link.oldSigningPublicKey, 32),
        );
    } catch {
        return false;
    }
}

/*
 * Whether `links` carry a contact from the keys pinned to the keys served:
 * the first link starts at the pinned keys (and version, when the pin has
 * one; links before the pinned keys are skipped when it has none), each link
 * starts where the one before ended and is signed by the signing key it
 * replaces, and the last ends at the served version and names the served
 * X25519, Ed25519 and ML-KEM keys. Any gap, fork or bad signature and the
 * chain does not hold; that is the changed-key warning, never a silent update.
 */
export async function verifySuccessionChain(
    userId: string,
    pinned: PinnedKeys,
    served: ServedKeys,
    links: SuccessionLink[],
) {
    const start =
        pinned.keyVersion === null
            ? links.findIndex(
                  (link) =>
                      link.oldEncryptionPublicKey === pinned.encryptionPublicKey &&
                      link.oldSigningPublicKey === pinned.signingPublicKey,
              )
            : 0;
    if (start < 0) return false;
    const chain = links.slice(start);
    let at = {
        keyVersion: pinned.keyVersion ?? chain[0]?.oldKeyVersion,
        encryptionPublicKey: pinned.encryptionPublicKey,
        signingPublicKey: pinned.signingPublicKey,
        kemPublicKey: null as string | null,
    };
    for (const link of chain) {
        if (
            link.oldKeyVersion !== at.keyVersion ||
            link.oldEncryptionPublicKey !== at.encryptionPublicKey ||
            link.oldSigningPublicKey !== at.signingPublicKey ||
            !(await verifySuccessionLink(userId, link))
        )
            return false;
        at = {
            keyVersion: link.newKeyVersion,
            encryptionPublicKey: link.newEncryptionPublicKey,
            signingPublicKey: link.newSigningPublicKey,
            kemPublicKey: link.newKemPublicKey,
        };
    }
    return (
        chain.length > 0 &&
        at.keyVersion === served.keyVersion &&
        at.encryptionPublicKey === served.encryptionPublicKey &&
        at.signingPublicKey === served.signingPublicKey &&
        at.kemPublicKey === served.kemPublicKey
    );
}
