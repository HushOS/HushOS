import type {
    KeyAssertion,
    KeyCreationOptions,
    KeyRegistration,
    KeyRequestOptions,
} from '@hushos/auth/api';
import type { PasskeyDriver } from '@hushos/auth/client';

/*
 * Passkeys and security keys in the browser (docs/two-step-design.md 3): WebAuthn, through
 * `@simplewebauthn/browser`'s JSON helpers. The library is a chunk of its own, fetched when a
 * step that offers a key comes on screen or a key is about to be added (`preloadPasskeys`),
 * never with the sign-in page itself. Each ceremony starts on the press that asked for it:
 * the browser's sheet never opens on page load.
 *
 * Only what the server checks is sent back: the credential id, the client data, and the
 * authenticator data with its signature (or the attestation object, which the server asked to
 * carry no attestation). Extension results and the attachment stay here.
 */
const library = () => import('@simplewebauthn/browser');

/* Fetches the library ahead of the press that will need it, so the press goes straight to the key. */
export function preloadPasskeys() {
    if (passkeys.supported()) void library().catch(() => {});
}

type Descriptors = Parameters<
    Awaited<ReturnType<typeof library>>['startAuthentication']
>[0]['optionsJSON']['allowCredentials'];

export const passkeys: PasskeyDriver = {
    supported: () =>
        typeof window !== 'undefined' &&
        window.isSecureContext &&
        typeof window.PublicKeyCredential === 'function',
    async get(options: KeyRequestOptions): Promise<KeyAssertion> {
        const { startAuthentication } = await library();
        const answer = await startAuthentication({
            optionsJSON: {
                ...options,
                // The server's transports are the specification's names, kept as it stored them.
                allowCredentials: options.allowCredentials as Descriptors,
            },
        });
        return {
            id: answer.id,
            rawId: answer.rawId,
            type: 'public-key',
            response: {
                clientDataJSON: answer.response.clientDataJSON,
                authenticatorData: answer.response.authenticatorData,
                signature: answer.response.signature,
            },
        };
    },
    async create(options: KeyCreationOptions): Promise<KeyRegistration> {
        const { startRegistration } = await library();
        const answer = await startRegistration({
            optionsJSON: {
                ...options,
                excludeCredentials: options.excludeCredentials as Descriptors,
            },
        });
        return {
            id: answer.id,
            rawId: answer.rawId,
            type: 'public-key',
            response: {
                clientDataJSON: answer.response.clientDataJSON,
                attestationObject: answer.response.attestationObject,
                ...(answer.response.transports?.length
                    ? { transports: answer.response.transports }
                    : {}),
            },
        };
    },
};
