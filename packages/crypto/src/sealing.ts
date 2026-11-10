import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import { hybridKeyWithSalt } from './hybrid';
import {
    KEM_CIPHERTEXT_BYTES,
    KEM_PUBLIC_KEY_BYTES,
    KEM_SECRET_KEY_BYTES,
    kemDecapsulate,
    kemEncapsulate,
} from './pq';
import {
    HYBRID_SIGNATURE_BYTES,
    signHybrid,
    verifyHybrid,
    type HybridPublicKey,
    type HybridSigningKey,
} from './signatures';

/*
 * The share suite 4 construction (docs/identity-pq-design.md 3), once, for
 * shares (shares.ts) and the group seals (groups.ts). Internal: not in the
 * package's exports, so nothing outside this package can seal under a kind's
 * `info` and associated data of its own choosing.
 */

/* The grantee as the granter sees them, both keys checked against the grantee's pin. */
export type GranteeKeys = {
    encryptionPublicKey: Uint8Array;
    kemPublicKey: Uint8Array | null;
};
/* The grantee's own private halves. */
export type GranteeSecrets = {
    privateKey: Uint8Array;
    kemSecretKey: Uint8Array | null;
};

/* Raw X25519, refusing a low-order key whose agreement is all zeros. */
function agree(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array) {
    if (theirPublicKey.length !== 32 || myPrivateKey.length !== 32)
        throw new CryptoError('Invalid identity key.');
    try {
        return sodium.crypto_scalarmult(myPrivateKey, theirPublicKey) as Uint8Array<ArrayBuffer>;
    } catch {
        throw new CryptoError('Invalid identity key.');
    }
}

/* salt = SHA-256(kemCiphertext || ephemeralPublicKey || granteePublicKey) */
async function hybridSealKey(
    dh: Uint8Array,
    kemSecret: Uint8Array,
    kemCiphertext: Uint8Array,
    ephemeralPublicKey: Uint8Array,
    granteePublicKey: Uint8Array,
    info: string,
) {
    const transcript = new Uint8Array(KEM_CIPHERTEXT_BYTES + 64);
    transcript.set(kemCiphertext);
    transcript.set(ephemeralPublicKey, KEM_CIPHERTEXT_BYTES);
    transcript.set(granteePublicKey, KEM_CIPHERTEXT_BYTES + 32);
    const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));
    return hybridKeyWithSalt(dh, kemSecret, salt, info);
}

/*
 * The suite 4 construction with the payload, HKDF `info`, associated data and
 * signed statement of the caller's choosing: what a share and the group seals
 * (docs/groups-design.md 2.3, 2.6, 2.9) are made with. The envelope is the
 * ephemeral X25519 public key, the KEM ciphertext, the nonce, the body (the
 * payload sealed under the hybrid key) and the signer's hybrid signature over
 * `statement(everything before it)`. Each kind has its own `info` and
 * associated data, so an envelope of one kind opens as nothing as another.
 */
export type HybridSealKind = {
    info: string;
    associatedData: Uint8Array;
    statement: (sealed: Uint8Array) => Promise<Uint8Array>;
    /* What the envelope is called, and what a reader is told when it is malformed or its signature does not hold. */
    noun: string;
    invalid: string;
    unsigned: string;
};

/* An envelope's length for a payload of `payloadBytes`. */
export function hybridSealBytes(payloadBytes: number) {
    return 32 + KEM_CIPHERTEXT_BYTES + 24 + payloadBytes + 16 + HYBRID_SIGNATURE_BYTES;
}

/*
 * Seals `payload` to the recipient's X25519 and ML-KEM keys under `kind`,
 * signed with the sealer's hybrid identity signature. The recipient's keys
 * must be ones the sealer checked: sealing to an unchecked key is sealing to
 * a stranger.
 */
export async function sealHybrid(
    payload: Uint8Array,
    recipient: GranteeKeys,
    sealer: HybridSigningKey,
    kind: HybridSealKind,
) {
    await sodium.ready;
    // Hybrid only: a key sealed to X25519 alone is a harvest-now, decrypt-later target,
    // and withholding the KEM key is all it would take.
    if (!recipient.kemPublicKey)
        throw new CryptoError('This person has no post-quantum key yet, so nothing was shared.');
    if (recipient.kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES)
        throw new CryptoError('Invalid identity key.');
    const ephemeral = sodium.crypto_box_keypair();
    let dh: Uint8Array | undefined;
    try {
        dh = agree(ephemeral.privateKey, recipient.encryptionPublicKey);
        const { ciphertext, sharedSecret } = kemEncapsulate(recipient.kemPublicKey);
        const key = await hybridSealKey(
            dh,
            sharedSecret,
            ciphertext,
            ephemeral.publicKey,
            recipient.encryptionPublicKey,
            kind.info,
        );
        sharedSecret.fill(0);
        try {
            const nonce = crypto.getRandomValues(new Uint8Array(24));
            const body = await encryptKey(payload, key, nonce, kind.associatedData);
            const signed = 32 + KEM_CIPHERTEXT_BYTES + 24 + body.length;
            const envelope = new Uint8Array(signed + HYBRID_SIGNATURE_BYTES);
            envelope.set(ephemeral.publicKey);
            envelope.set(ciphertext, 32);
            envelope.set(nonce, 32 + KEM_CIPHERTEXT_BYTES);
            envelope.set(body, 32 + KEM_CIPHERTEXT_BYTES + 24);
            const statement = await kind.statement(envelope.subarray(0, signed));
            envelope.set(await signHybrid(statement, sealer), signed);
            return envelope;
        } finally {
            key.fill(0);
        }
    } finally {
        ephemeral.privateKey.fill(0);
        dh?.fill(0);
    }
}

/*
 * Opens an envelope sealed to this identity under `kind`: the payload, of
 * exactly `payloadBytes`. Only once both halves of its signature verify under
 * `sealer`, keys the reader already trusts for the person who sealed it;
 * nothing is decapsulated before.
 */
export async function openHybrid(
    envelope: Uint8Array,
    payloadBytes: number,
    sealers: readonly HybridPublicKey[],
    recipient: GranteeSecrets,
    kind: HybridSealKind,
) {
    await sodium.ready;
    if (envelope.length !== hybridSealBytes(payloadBytes)) throw new CryptoError(kind.invalid);
    const signed = envelope.length - HYBRID_SIGNATURE_BYTES;
    const statement = await kind.statement(envelope.subarray(0, signed));
    // Any one of the sealer's keys the caller trusts will do (a member's earlier keys, 2.4).
    let holds = false;
    for (const sealer of sealers)
        if (
            sealer.signingPublicKey.length === 32 &&
            sealer.mlDsaPublicKey.length === 1952 &&
            (await verifyHybrid(statement, envelope.subarray(signed), sealer))
        ) {
            holds = true;
            break;
        }
    if (!holds) throw new CryptoError(kind.unsigned);
    if (!recipient.kemSecretKey || recipient.kemSecretKey.length !== KEM_SECRET_KEY_BYTES)
        throw new CryptoError(
            `This ${kind.noun} was sealed to a key this account does not hold yet. Unlock again and retry.`,
        );
    const ephemeralPublicKey = envelope.subarray(0, 32);
    const ciphertext = envelope.subarray(32, 32 + KEM_CIPHERTEXT_BYTES);
    const nonce = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES, 32 + KEM_CIPHERTEXT_BYTES + 24);
    const body = envelope.subarray(32 + KEM_CIPHERTEXT_BYTES + 24, signed);
    const dh = agree(recipient.privateKey, ephemeralPublicKey);
    try {
        const sharedSecret = kemDecapsulate(ciphertext, recipient.kemSecretKey);
        const key = await hybridSealKey(
            dh,
            sharedSecret,
            ciphertext,
            ephemeralPublicKey,
            sodium.crypto_scalarmult_base(recipient.privateKey),
            kind.info,
        );
        sharedSecret.fill(0);
        try {
            return (await decryptKey(
                body,
                key,
                nonce,
                kind.associatedData,
            )) as Uint8Array<ArrayBuffer>;
        } finally {
            key.fill(0);
        }
    } finally {
        dh.fill(0);
    }
}
