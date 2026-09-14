import { argon2id } from 'hash-wasm';
import sodium from 'libsodium-wrappers';
import { CryptoError } from './errors';
import { decryptKey, encryptKey } from './aead';
import { KEY_STRETCHING } from './protocol';

/*
 * A link is a share without a grantee, as the design fixes it: a 32-byte
 * secret lives in the URL fragment and never reaches the server; an optional
 * password is stretched with argon2id under the account layer's profile and a
 * per-link salt (32 zero bytes stand in without a password); the two are
 * hashed together into the key that seals the node key, with the link's
 * context as associated data. The server holds the sealed body, the salt and
 * a hash of the path token, and can open nothing.
 */

export const LINK_SECRET_BYTES = 32;
export const LINK_SALT_BYTES = 16;
export const LINK_ENVELOPE_BYTES = 24 + 32 + 16;

export type LinkContext = {
    workspaceId: string;
    nodeId: string;
    keyEpoch: number;
    linkId: string;
};

export function linkContext(ctx: LinkContext) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/link',
            1,
            ctx.workspaceId.toLowerCase(),
            ctx.nodeId.toLowerCase(),
            ctx.keyEpoch,
            ctx.linkId.toLowerCase(),
        ]),
    );
}

/* The password's contribution: argon2id under the account profile, or zeros without one. */
export async function passwordKey(password: string | null, salt: Uint8Array) {
    if (password === null) return new Uint8Array(32);
    if (salt.length !== LINK_SALT_BYTES) throw new CryptoError('Invalid link salt.');
    const profile = KEY_STRETCHING['argon2id-custom'];
    const hex = await argon2id({
        password,
        salt,
        parallelism: profile.parallelism,
        iterations: profile.iterations,
        memorySize: profile.memory,
        hashLength: 32,
        outputType: 'hex',
    });
    return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

/* The link key from the secret and the password's stretched key (zeros without a password). */
export async function linkKeyFrom(secret: Uint8Array, fromPassword: Uint8Array) {
    await sodium.ready;
    if (secret.length !== LINK_SECRET_BYTES) throw new CryptoError('Invalid link secret.');
    if (fromPassword.length !== 32) throw new CryptoError('Invalid link password key.');
    const input = new Uint8Array(64);
    input.set(secret);
    input.set(fromPassword, 32);
    try {
        return sodium.crypto_generichash(32, input, null) as Uint8Array<ArrayBuffer>;
    } finally {
        input.fill(0);
    }
}
async function linkKey(secret: Uint8Array, password: string | null, salt: Uint8Array) {
    const fromPassword = await passwordKey(password, salt);
    try {
        return await linkKeyFrom(secret, fromPassword);
    } finally {
        fromPassword.fill(0);
    }
}

export function generateLinkSecret() {
    return crypto.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
}
export function generateLinkSalt() {
    return crypto.getRandomValues(new Uint8Array(LINK_SALT_BYTES));
}

export async function sealLinkKey(
    nodeKey: Uint8Array,
    secret: Uint8Array,
    password: string | null,
    salt: Uint8Array,
    ctx: LinkContext,
) {
    const key = await linkKey(secret, password, salt);
    try {
        return await sealUnderLinkKey(nodeKey, key, ctx);
    } finally {
        key.fill(0);
    }
}
/* The same seal from a password key already stretched: what a rotation uses, since the owner never sees the password again. */
export async function sealLinkKeyWith(
    nodeKey: Uint8Array,
    secret: Uint8Array,
    fromPassword: Uint8Array,
    ctx: LinkContext,
) {
    const key = await linkKeyFrom(secret, fromPassword);
    try {
        return await sealUnderLinkKey(nodeKey, key, ctx);
    } finally {
        key.fill(0);
    }
}
async function sealUnderLinkKey(nodeKey: Uint8Array, key: Uint8Array, ctx: LinkContext) {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const body = await encryptKey(nodeKey, key, nonce, linkContext(ctx));
    const envelope = new Uint8Array(LINK_ENVELOPE_BYTES);
    envelope.set(nonce);
    envelope.set(body, 24);
    return envelope;
}

export async function openLinkKey(
    envelope: Uint8Array,
    secret: Uint8Array,
    password: string | null,
    salt: Uint8Array,
    ctx: LinkContext,
) {
    if (envelope.length !== LINK_ENVELOPE_BYTES) throw new CryptoError('Invalid link envelope.');
    const key = await linkKey(secret, password, salt);
    try {
        return (await decryptKey(
            envelope.subarray(24),
            key,
            envelope.subarray(0, 24),
            linkContext(ctx),
        )) as Uint8Array<ArrayBuffer>;
    } finally {
        key.fill(0);
    }
}

/*
 * The owner's copy of what makes a link: the fragment secret, the path token
 * and the password's stretched key, sealed under the node key with the link's
 * context. It lets the owner show the link again, change its password, move
 * its expiry, or re-seal it after a key rotation without minting a new one or
 * knowing the password; the server stores it and can open nothing. Envelopes
 * from before the password key was kept are 32 bytes shorter and open without
 * it; a link with a password sealed that way cannot survive a rotation.
 */
export const LINK_TOKEN_BYTES = 32;
export const LINK_SECRET_ENVELOPE_BYTES =
    24 + LINK_SECRET_BYTES + LINK_TOKEN_BYTES + LINK_SECRET_BYTES + 16;
export const LINK_SECRET_ENVELOPE_LEGACY_BYTES = 24 + LINK_SECRET_BYTES + LINK_TOKEN_BYTES + 16;

function secretContext(ctx: LinkContext) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/drive/link-secret',
            1,
            ctx.workspaceId.toLowerCase(),
            ctx.nodeId.toLowerCase(),
            ctx.keyEpoch,
            ctx.linkId.toLowerCase(),
        ]),
    );
}

export async function sealLinkSecret(
    secret: Uint8Array,
    token: Uint8Array,
    fromPassword: Uint8Array,
    nodeKey: Uint8Array,
    ctx: LinkContext,
) {
    if (
        secret.length !== LINK_SECRET_BYTES ||
        token.length !== LINK_TOKEN_BYTES ||
        fromPassword.length !== 32
    )
        throw new CryptoError('Invalid link secret.');
    const plaintext = new Uint8Array(LINK_SECRET_BYTES + LINK_TOKEN_BYTES + 32);
    plaintext.set(secret);
    plaintext.set(token, LINK_SECRET_BYTES);
    plaintext.set(fromPassword, LINK_SECRET_BYTES + LINK_TOKEN_BYTES);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    try {
        const body = await encryptKey(plaintext, nodeKey, nonce, secretContext(ctx));
        const envelope = new Uint8Array(LINK_SECRET_ENVELOPE_BYTES);
        envelope.set(nonce);
        envelope.set(body, 24);
        return envelope;
    } finally {
        plaintext.fill(0);
    }
}

export async function openLinkSecret(envelope: Uint8Array, nodeKey: Uint8Array, ctx: LinkContext) {
    if (
        envelope.length !== LINK_SECRET_ENVELOPE_BYTES &&
        envelope.length !== LINK_SECRET_ENVELOPE_LEGACY_BYTES
    )
        throw new CryptoError('Invalid link secret envelope.');
    const plaintext = await decryptKey(
        envelope.subarray(24),
        nodeKey,
        envelope.subarray(0, 24),
        secretContext(ctx),
    );
    const legacy = envelope.length === LINK_SECRET_ENVELOPE_LEGACY_BYTES;
    return {
        secret: plaintext.slice(0, LINK_SECRET_BYTES) as Uint8Array<ArrayBuffer>,
        token: plaintext.slice(
            LINK_SECRET_BYTES,
            LINK_SECRET_BYTES + LINK_TOKEN_BYTES,
        ) as Uint8Array<ArrayBuffer>,
        /* Null for an envelope sealed before the password key was kept. */
        fromPassword: legacy
            ? null
            : (plaintext.slice(LINK_SECRET_BYTES + LINK_TOKEN_BYTES) as Uint8Array<ArrayBuffer>),
    };
}
