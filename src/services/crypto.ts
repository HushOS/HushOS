import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import sodium from 'libsodium-wrappers-sumo';

import { expose } from '@/lib/comlink';
import { MetadataBundle, UserCryptoProperties } from '@/lib/types';

export const CryptoService = {
    generateRequiredKeys: async (
        password: string
    ): Promise<{
        cryptoProperties: UserCryptoProperties;
        recoveryMnemonic: string;
        mainKey: string;
        asymmetricPrivateKey: string;
        signingPrivateKey: string;
    }> => {
        await sodium.ready;

        const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
        const passwordHash = sodium.crypto_pwhash(
            sodium.crypto_box_SEEDBYTES,
            password,
            salt,
            sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_ALG_DEFAULT
        );

        // Main Key
        const mainKey = sodium.crypto_kdf_keygen();
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedMainKey = sodium.crypto_secretbox_easy(mainKey, nonce, passwordHash);

        // Asymmetric Keys
        const asymmetricKp = sodium.crypto_box_keypair();
        const asymmetricKeyNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        const encryptedAsymmetricPrivateKey = sodium.crypto_secretbox_easy(
            asymmetricKp.privateKey,
            asymmetricKeyNonce,
            mainKey
        );

        const signingKp = sodium.crypto_sign_keypair();
        const signingKeyNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        const encryptedSigningPrivateKey = sodium.crypto_secretbox_easy(
            signingKp.privateKey,
            signingKeyNonce,
            mainKey
        );

        // Recovery Keys
        const recoveryKey = sodium.crypto_kdf_keygen();
        const recoveryMainKeyNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const recoveryEncryptedMainKey = sodium.crypto_secretbox_easy(
            mainKey,
            recoveryMainKeyNonce,
            recoveryKey,
            'base64'
        );

        const recoveryKeyNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedRecoveryKey = sodium.crypto_secretbox_easy(
            recoveryKey,
            recoveryKeyNonce,
            passwordHash,
            'base64'
        );

        const recoveryMnemonic = entropyToMnemonic(recoveryKey, wordlist);

        return {
            recoveryMnemonic,
            mainKey: sodium.to_base64(mainKey),
            asymmetricPrivateKey: sodium.to_base64(asymmetricKp.privateKey),
            signingPrivateKey: sodium.to_base64(signingKp.privateKey),
            cryptoProperties: {
                salt: sodium.to_base64(salt),
                mainKeyBundle: {
                    nonce: sodium.to_base64(nonce),
                    encryptedKey: sodium.to_base64(encryptedMainKey),
                },
                recoveryMainKeyBundle: {
                    nonce: sodium.to_base64(recoveryMainKeyNonce),
                    encryptedKey: recoveryEncryptedMainKey,
                },
                recoveryKeyBundle: {
                    nonce: sodium.to_base64(recoveryKeyNonce),
                    encryptedKey: encryptedRecoveryKey,
                },
                asymmetricKeyBundle: {
                    nonce: sodium.to_base64(asymmetricKeyNonce),
                    publicKey: sodium.to_base64(asymmetricKp.publicKey),
                    encryptedPrivateKey: sodium.to_base64(encryptedAsymmetricPrivateKey),
                },
                signingKeyBundle: {
                    nonce: sodium.to_base64(signingKeyNonce),
                    publicKey: sodium.to_base64(signingKp.publicKey),
                    encryptedPrivateKey: sodium.to_base64(encryptedSigningPrivateKey),
                },
            },
        };
    },

    decryptRequiredKeys: async (
        password: string,
        cryptoProperties: Omit<UserCryptoProperties, 'recoveryKeyBundle' | 'recoveryMainKeyBundle'>
    ) => {
        await sodium.ready;

        const passwordHash = sodium.crypto_pwhash(
            sodium.crypto_box_SEEDBYTES,
            password,
            sodium.from_base64(cryptoProperties.salt),
            sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_ALG_DEFAULT
        );

        const mainKey = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(cryptoProperties.mainKeyBundle.encryptedKey),
            sodium.from_base64(cryptoProperties.mainKeyBundle.nonce),
            passwordHash
        );

        const asymmetricPrivateKey = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(cryptoProperties.asymmetricKeyBundle.encryptedPrivateKey),
            sodium.from_base64(cryptoProperties.asymmetricKeyBundle.nonce),
            mainKey
        );

        const signingPrivateKey = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(cryptoProperties.signingKeyBundle.encryptedPrivateKey),
            sodium.from_base64(cryptoProperties.signingKeyBundle.nonce),
            mainKey
        );

        return {
            mainKey: sodium.to_base64(mainKey),
            asymmetricPrivateKey: sodium.to_base64(asymmetricPrivateKey),
            signingPrivateKey: sodium.to_base64(signingPrivateKey),
        };
    },

    asymmetricDecrypt: async (
        data: string,
        nonce: string,
        publicKey: string,
        privateKey: string
    ) => {
        await sodium.ready;

        const token = sodium.crypto_box_open_easy(
            sodium.from_base64(data),
            sodium.from_base64(nonce),
            sodium.from_base64(publicKey),
            sodium.from_base64(privateKey)
        );

        return sodium.to_string(token);
    },

    generateDirectoryKey: async (key: string) => {
        await sodium.ready;

        const directoryKey = sodium.crypto_secretbox_keygen();

        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedDirectoryKey = sodium.crypto_secretbox_easy(
            directoryKey,
            nonce,
            sodium.from_base64(key),
            'base64'
        );

        return {
            directoryKey,
            directoryKeyB64: sodium.to_base64(directoryKey),
            encryptedDirectoryKey,
            nonce: sodium.to_base64(nonce),
        };
    },

    decryptDirectoryKey: async (
        key: string,
        encryptedDirectoryKey: string,
        directoryKeyNonce: string
    ) => {
        await sodium.ready;

        const directoryKey = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(encryptedDirectoryKey),
            sodium.from_base64(directoryKeyNonce),
            sodium.from_base64(key),
            'base64'
        );

        return directoryKey;
    },

    generateFileKey: async (key: string) => {
        await sodium.ready;

        const fileKey = sodium.crypto_secretstream_xchacha20poly1305_keygen();

        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedFileKey = sodium.crypto_secretbox_easy(
            fileKey,
            nonce,
            sodium.from_base64(key),
            'base64'
        );

        return {
            fileKey,
            fileKeyB64: sodium.to_base64(fileKey),
            encryptedFileKey,
            nonce: sodium.to_base64(nonce),
        };
    },

    decryptFileKey: async (key: string, encryptedFileKey: string, fileKeyNonce: string) => {
        await sodium.ready;

        const fileKey = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(encryptedFileKey),
            sodium.from_base64(fileKeyNonce),
            sodium.from_base64(key),
            'base64'
        );

        return fileKey;
    },

    reEncryptKey: async (key: string, currentKey: string) => {
        await sodium.ready;

        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedKey = sodium.crypto_secretbox_easy(
            sodium.from_base64(currentKey),
            nonce,
            sodium.from_base64(key),
            'base64'
        );

        return {
            key: sodium.from_base64(currentKey),
            encryptedKey,
            nonce: sodium.to_base64(nonce),
        };
    },

    encryptMetadata: async (
        key: Uint8Array | string,
        metadata: unknown
    ): Promise<MetadataBundle> => {
        await sodium.ready;

        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

        const encryptedMetadata = sodium.crypto_secretbox_easy(
            JSON.stringify(metadata),
            nonce,
            typeof key === 'string' ? sodium.from_base64(key) : key,
            'base64'
        );

        return { encryptedMetadata, nonce: sodium.to_base64(nonce) };
    },

    decryptMetadata: async (key: string, encryptedMetadata: string, metadataNonce: string) => {
        await sodium.ready;

        const decryptedMetadata = sodium.crypto_secretbox_open_easy(
            sodium.from_base64(encryptedMetadata),
            sodium.from_base64(metadataNonce),
            sodium.from_base64(key)
        );

        return sodium.to_string(decryptedMetadata);
    },

    encryptFile: async (key: Uint8Array, file: Uint8Array) => {
        await sodium.ready;
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        return {
            fileKey: sodium.crypto_secretbox_easy(file, nonce, key),
            nonce: sodium.to_base64(nonce),
        };
    },

    decryptFile: async (key: string, data: Uint8Array, nonce: string) => {
        await sodium.ready;
        return sodium.crypto_secretbox_open_easy(
            data,
            sodium.from_base64(nonce),
            sodium.from_base64(key)
        );
    },

    streamingEncryptionInit: async (key: string) => {
        await sodium.ready;
        return sodium.crypto_secretstream_xchacha20poly1305_init_push(sodium.from_base64(key));
    },

    streamingEncryptionPush: async (
        state: sodium.StateAddress,
        data: Uint8Array,
        isFinal: boolean
    ) => {
        await sodium.ready;
        return sodium.crypto_secretstream_xchacha20poly1305_push(
            state,
            data,
            null,
            isFinal ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : 0
        );
    },

    streamingDecryptionInit: async (
        header: Uint8Array,
        key: string
    ): Promise<sodium.StateAddress> => {
        await sodium.ready;
        return sodium.crypto_secretstream_xchacha20poly1305_init_pull(
            header,
            sodium.from_base64(key)
        );
    },

    streamingDecryptionPull: async (state: sodium.StateAddress, cipher: Uint8Array) => {
        await sodium.ready;
        return sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipher);
    },

    generateRandomKeyForCompat: async () => {
        await sodium.ready;
        return sodium.crypto_secretstream_xchacha20poly1305_keygen();
    },
};

expose(CryptoService);
