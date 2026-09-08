import { decode, encode } from './keys';

export type RememberedAccount = {
    version: 1;
    userId: string;
    keyVersion: number;
    credentialVersion: number;
    deviceKeyId: string;
    nonce: string;
    encryptedKey: string;
};
function context(bundle: Omit<RememberedAccount, 'nonce' | 'encryptedKey'>) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/device-unlock',
            bundle.version,
            bundle.userId.toLowerCase(),
            bundle.keyVersion,
            bundle.credentialVersion,
            bundle.deviceKeyId,
        ]),
    );
}
export function createDeviceKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
    ]);
}
export async function rememberAccountKey(
    accountKey: Uint8Array<ArrayBuffer>,
    deviceKey: CryptoKey,
    identity: Omit<RememberedAccount, 'nonce' | 'encryptedKey' | 'version'>,
): Promise<RememberedAccount> {
    const header = { ...identity, version: 1 as const };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: context(header), tagLength: 128 },
        deviceKey,
        accountKey,
    );
    return { ...header, nonce: encode(nonce), encryptedKey: encode(new Uint8Array(encrypted)) };
}
export async function restoreAccountKey(bundle: RememberedAccount, deviceKey: CryptoKey) {
    if (
        bundle.version !== 1 ||
        !Number.isSafeInteger(bundle.keyVersion) ||
        bundle.keyVersion < 1 ||
        !Number.isSafeInteger(bundle.credentialVersion) ||
        bundle.credentialVersion < 1
    )
        throw new Error('This saved account-key version is not supported.');
    const decrypted = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: decode(bundle.nonce, 12),
            additionalData: context(bundle),
            tagLength: 128,
        },
        deviceKey,
        decode(bundle.encryptedKey, 48),
    );
    const key = new Uint8Array(decrypted);
    if (key.length !== 32) throw new Error('Invalid saved account key.');
    return key;
}
