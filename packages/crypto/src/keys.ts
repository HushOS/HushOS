import { CryptoError } from './errors';
import { OPAQUE_PROFILE_VERSION, PASSWORD_WRAPPING_CONTEXT } from './protocol';

export function encode(value: Uint8Array) {
    // In chunks: spreading a large array into one call exceeds the engine's argument limit.
    let binary = '';
    for (let at = 0; at < value.length; at += 0x2000)
        binary += String.fromCharCode(...value.subarray(at, at + 0x2000));
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
/*
 * Canonical base64url without padding, of `length` bytes when given, or a
 * CryptoError. A length of 1 mod 4 is no base64 at all: refused here, before
 * atob, which would throw a DOMException that callers do not treat as a
 * refusal.
 */
export function decode(value: string, length?: number) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
        throw new CryptoError('Invalid key encoding.');
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
        char.charCodeAt(0),
    );
    if (encode(bytes) !== value || (length !== undefined && bytes.length !== length))
        throw new CryptoError('Invalid key encoding.');
    return bytes;
}
export async function wrappingKey(value: string, salt: Uint8Array<ArrayBuffer>) {
    const decoded = decode(value);
    try {
        const key = await crypto.subtle.importKey('raw', decoded, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt,
                    info: new TextEncoder().encode(PASSWORD_WRAPPING_CONTEXT),
                },
                key,
                256,
            ),
        );
    } finally {
        decoded.fill(0);
    }
}
export function checkProfile(version: number) {
    if (version !== OPAQUE_PROFILE_VERSION)
        throw new CryptoError('This authentication profile is not supported.');
}
