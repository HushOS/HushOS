import { CryptoError } from './errors';
import { encode } from './keys';

/*
 * The device key (docs/devices-design.md, step 1): an Ed25519 key a browser
 * makes for itself, kept as a non-extractable Web Crypto key, and used for one
 * thing so far: to come back to its own device row at the next sign-in. It
 * signs
 *
 *     ["hushos/device/session",1,userId,deviceId,sha256(attemptToken)]
 *
 * where the digest is SHA-256 of the sign-in attempt's token (its UTF-8 bytes),
 * base64url. The server consumes the attempt before it checks anything, so a
 * signature is good for exactly one sign-in. `packages/db/src/signatures.ts`
 * and `crates/hushos-core/src/devices.rs` build the same bytes; the fixtures
 * hold the three to each other.
 */

const DOMAIN = 'hushos/device/session';

async function sha256(bytes: Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
}

/* The digest a device session statement names: SHA-256 of the attempt token's bytes, base64url. */
export async function attemptDigest(attemptToken: string) {
    return encode(await sha256(new TextEncoder().encode(attemptToken)));
}

/*
 * Which account a stored device key was made for, without storing the address:
 * SHA-256 of the email trimmed and lowercased, base64url. A device sends its
 * proof only when the email being typed has this digest, so a browser two
 * people share never tells the server that one person's device is signing in
 * as the other.
 */
export async function emailDigest(email: string) {
    return encode(await sha256(new TextEncoder().encode(email.trim().toLowerCase())));
}

/*
 * An empty account, device or attempt is refused, as the Rust core refuses it
 * (devices.rs): no sign-in names one, so a statement over one proves nothing.
 */
export async function deviceSessionStatement(input: {
    userId: string;
    deviceId: string;
    attemptToken: string;
}) {
    if (!input.userId || !input.deviceId || !input.attemptToken)
        throw new CryptoError('Invalid device session.');
    return new TextEncoder().encode(
        JSON.stringify([
            DOMAIN,
            1,
            input.userId.toLowerCase(),
            input.deviceId.toLowerCase(),
            await attemptDigest(input.attemptToken),
        ]),
    );
}

/*
 * A new device key, or null where the browser has no Ed25519 in Web Crypto
 * (Chrome before 137, Safari before 17, Firefox before 129): such a device
 * registers without a key and simply cannot come back to its row.
 */
export async function createDeviceSigningKey(): Promise<{
    privateKey: CryptoKey;
    /* The raw 32-byte public key, base64url: what registration sends. */
    publicKey: string;
} | null> {
    try {
        const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
            'sign',
            'verify',
        ])) as CryptoKeyPair;
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        if (publicKey.length !== 32 || pair.privateKey.extractable) return null;
        return { privateKey: pair.privateKey, publicKey: encode(publicKey) };
    } catch {
        return null;
    }
}

/* The device's signature over its session statement for this attempt, base64url (64 bytes). */
export async function signDeviceSession(
    privateKey: CryptoKey,
    input: { userId: string; deviceId: string; attemptToken: string },
) {
    const statement = await deviceSessionStatement(input);
    return encode(
        new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, statement)),
    );
}
