import { CryptoError } from './errors';
import { OPAQUE_PROFILE_VERSION, PASSWORD_WRAPPING_CONTEXT } from './protocol';

export function encode(value: Uint8Array) {
    return btoa(String.fromCharCode(...value))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}
export function decode(value: string, length?: number) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CryptoError('Invalid key encoding.');
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
