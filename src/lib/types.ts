export type UserCryptoProperties = {
    salt: string;
    mainKeyBundle: SecretKeyBundle;
    recoveryMainKeyBundle: SecretKeyBundle;
    recoveryKeyBundle: SecretKeyBundle;
    asymmetricKeyBundle: KeyPairBundle;
    signingKeyBundle: KeyPairBundle;
};

export type MetadataBundle = {
    nonce: string;
    encryptedMetadata: string;
};

export type SecretKeyBundle = {
    nonce: string;
    encryptedKey: string;
};

export type KeyPairBundle = {
    nonce: string;
    publicKey: string;
    encryptedPrivateKey: string;
};

// https://medium.com/@jmagrippis/website-analytics-with-next-js-and-plausible-io-3620da743a1

export type TrackEvent = 'Signup' | 'Joined Waitlist';

export type PlausibleArgs = [TrackEvent, () => void] | [TrackEvent];

declare global {
    const plausible: {
        (...args: PlausibleArgs): void;
        q?: PlausibleArgs[];
    };

    interface Window {
        plausible?: typeof plausible;
    }
}
