import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
    AuthenticationResponseJSON,
    AuthenticatorTransport,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { authEnv } from '@hushos/env/auth';
import type { KeyCreationOptions, KeyDescriptor, KeyRequestOptions } from './api';
import { twoStepEnv } from '@hushos/env/two-step';

/*
 * Passkeys and security keys as a second step (docs/two-step-design.md 3): the options the
 * server hands out and the checks it makes on what comes back. `@simplewebauthn/server` parses
 * the COSE keys and verifies responses to the specification; this module fixes what HushOS
 * asks for and accepts, in one place:
 * - the RP ID is the host of APP_ORIGIN, and a response's origin must be APP_ORIGIN exactly,
 *   or one of the Android app origins the operator listed (WEBAUTHN_ANDROID_ORIGINS);
 * - no attestation, no resident key, no user verification: the password is the knowledge
 *   factor, and the server learns no maker or model;
 * - Ed25519, ES256 and RS256, offered and accepted, and nothing else;
 * - the challenge is the caller's, 32 random bytes kept with the token it belongs to.
 * Nothing here reads or writes a row: the callers in two-step.ts own the tokens and counters.
 */

/*
 * The two option objects are served as api.ts types them: WebAuthn's JSON forms
 * (PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON) with every
 * field this server sets present, and none it does not set. The web hands them to the
 * browser as they are; the phone apps read the same fields.
 */
export type { KeyCreationOptions, KeyRequestOptions };

/* Five minutes, as long as the token the ceremony belongs to. */
const TIMEOUT_MS = 300_000;
/* COSE: EdDSA (Ed25519), ES256, RS256 (docs/two-step-design.md 3). */
const ALGORITHMS = [-8, -7, -257];
const TRANSPORTS: ReadonlySet<string> = new Set([
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
]);

/* Who the keys are bound to: the host of APP_ORIGIN, and the origins a response may come from. */
export function relyingParty() {
    const origin = new URL(authEnv.APP_ORIGIN);
    return {
        id: origin.hostname,
        origins: [origin.origin, ...twoStepEnv.WEBAUTHN_ANDROID_ORIGINS],
    };
}

/* The transports a client reported, kept only where they are ones the specification names. */
function knownTransports(value: unknown) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((entry): entry is string => TRANSPORTS.has(entry)))].slice(
        0,
        8,
    ) as AuthenticatorTransport[];
}

type KnownCredential = { credentialId: Buffer; transports: string[] };
const descriptors = (credentials: KnownCredential[]) =>
    credentials.map((credential) => ({
        id: credential.credentialId.toString('base64url'),
        transports: knownTransports(credential.transports),
    }));
/* A descriptor as it is served: the transports only when the key reported some. */
const served = (list: { id: string; transports?: string[] }[] | undefined): KeyDescriptor[] =>
    (list ?? []).map(({ id, transports }) => ({
        id,
        type: 'public-key',
        ...(transports?.length ? { transports } : {}),
    }));

/* What `navigator.credentials.create` is given to add a key (the table in the design, 3). */
export async function keyCreationOptions(input: {
    email: string;
    userHandle: Buffer;
    challenge: Buffer;
    exclude: KnownCredential[];
}): Promise<KeyCreationOptions> {
    const rp = relyingParty();
    const options = await generateRegistrationOptions({
        rpName: 'HushOS',
        rpID: rp.id,
        userName: input.email,
        userDisplayName: input.email,
        // Random per account, never the account id.
        userID: new Uint8Array(input.userHandle),
        challenge: new Uint8Array(input.challenge),
        timeout: TIMEOUT_MS,
        attestationType: 'none',
        excludeCredentials: descriptors(input.exclude),
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'discouraged' },
        supportedAlgorithmIDs: ALGORITHMS,
    });
    return {
        challenge: options.challenge,
        rp: { id: rp.id, name: options.rp.name },
        user: {
            id: options.user.id,
            name: options.user.name,
            displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams.map(({ alg }) => ({ type: 'public-key', alg })),
        timeout: TIMEOUT_MS,
        attestation: 'none',
        excludeCredentials: served(options.excludeCredentials),
        authenticatorSelection: {
            residentKey: 'discouraged',
            userVerification: 'discouraged',
            requireResidentKey: false,
        },
    };
}

/* What `navigator.credentials.get` is given to answer a step: the account's keys, after the password. */
export async function keyRequestOptions(input: {
    challenge: Buffer;
    credentials: KnownCredential[];
}): Promise<KeyRequestOptions> {
    const rp = relyingParty();
    const options = await generateAuthenticationOptions({
        rpID: rp.id,
        challenge: new Uint8Array(input.challenge),
        timeout: TIMEOUT_MS,
        userVerification: 'discouraged',
        allowCredentials: descriptors(input.credentials),
    });
    return {
        challenge: options.challenge,
        rpId: rp.id,
        timeout: TIMEOUT_MS,
        userVerification: 'discouraged',
        allowCredentials: served(options.allowCredentials),
    };
}

/*
 * A response made inside another site's frame says so (`crossOrigin`). HushOS is never framed,
 * so one that says it is refused before anything else is looked at. Unreadable client data
 * is refused the same way.
 */
function framed(clientDataJSON: unknown) {
    if (typeof clientDataJSON !== 'string') return true;
    try {
        const data: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
        if (typeof data !== 'object' || data === null) return true;
        return (data as { crossOrigin?: unknown }).crossOrigin === true;
    } catch {
        return true;
    }
}

export type VerifiedKey = {
    credentialId: Buffer;
    publicKey: Buffer;
    signCount: number;
    transports: string[];
    backupEligible: boolean;
    backupState: boolean;
};

/*
 * A key's registration, checked against the challenge of its registration token: the type is
 * `webauthn.create`, the challenge and origin are ours, the RP ID hash matches, user presence
 * is set and the algorithm is one that was offered. Null for anything else: the caller does
 * not say which check failed. No attestation statement and no AAGUID leave this function.
 */
export async function verifyKeyRegistration(input: {
    response: unknown;
    challenge: Buffer;
}): Promise<VerifiedKey | null> {
    const response = input.response as RegistrationResponseJSON;
    if (framed(response?.response?.clientDataJSON)) return null;
    const rp = relyingParty();
    try {
        const verified = await verifyRegistrationResponse({
            response,
            expectedChallenge: input.challenge.toString('base64url'),
            expectedOrigin: rp.origins,
            expectedRPID: rp.id,
            expectedType: 'webauthn.create',
            requireUserPresence: true,
            requireUserVerification: false,
            supportedAlgorithmIDs: ALGORITHMS,
        });
        if (!verified.verified) return null;
        const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
        const credentialId = Buffer.from(credential.id, 'base64url');
        const publicKey = Buffer.from(credential.publicKey);
        // What the table stores: anything outside it is not a key this server can keep.
        if (
            credentialId.length < 1 ||
            credentialId.length > 1023 ||
            publicKey.length < 1 ||
            publicKey.length > 2048 ||
            !Number.isSafeInteger(credential.counter) ||
            credential.counter < 0 ||
            credential.counter > 0xffff_ffff
        )
            return null;
        return {
            credentialId,
            publicKey,
            signCount: credential.counter,
            transports: knownTransports(response.response.transports),
            backupEligible: credentialDeviceType === 'multiDevice',
            backupState: credentialBackedUp,
        };
    } catch {
        return null;
    }
}

export type VerifiedAssertion =
    /* The counter the assertion carried, and whether the key says it is backed up now. */
    | { ok: true; signCount: number; backedUp: boolean }
    /*
     * `counter`: everything verified but the counter, which did not go up (WebAuthn 6.1.1). A
     * real key's signature with a counter the server has passed can mean the key was copied.
     */
    | { ok: false; counter: boolean };

type StoredKey = {
    credentialId: Buffer;
    publicKey: Buffer;
    signCount: number;
    transports: string[];
};

/*
 * A key's answer to a step, checked against the step token's challenge and the stored key:
 * the type is `webauthn.get`, the challenge and origin are ours, the RP ID hash matches, user
 * presence is set, the signature is this key's, and the counter went up when either the
 * stored one or the new one is non-zero (the library's rule, the specification's).
 */
export async function verifyKeyAssertion(input: {
    response: unknown;
    challenge: Buffer;
    key: StoredKey;
}): Promise<VerifiedAssertion> {
    const response = input.response as AuthenticationResponseJSON;
    if (framed(response?.response?.clientDataJSON)) return { ok: false, counter: false };
    const rp = relyingParty();
    const check = (counter: number) =>
        verifyAuthenticationResponse({
            response,
            expectedChallenge: input.challenge.toString('base64url'),
            expectedOrigin: rp.origins,
            expectedRPID: rp.id,
            expectedType: 'webauthn.get',
            requireUserVerification: false,
            credential: {
                id: input.key.credentialId.toString('base64url'),
                publicKey: new Uint8Array(input.key.publicKey),
                counter,
                transports: knownTransports(input.key.transports),
            },
        });
    try {
        const verified = await check(input.key.signCount);
        if (!verified.verified) return { ok: false, counter: false };
        const { newCounter, credentialBackedUp } = verified.authenticationInfo;
        return { ok: true, signCount: newCounter, backedUp: credentialBackedUp };
    } catch {
        // Refused. Whether the counter alone was why decides if the account is told its key
        // may have been copied: checked again as if nothing were stored, which passes only
        // when the challenge, origin, RP ID, presence and signature are all right.
        if (input.key.signCount === 0) return { ok: false, counter: false };
        try {
            return { ok: false, counter: (await check(0)).verified };
        } catch {
            return { ok: false, counter: false };
        }
    }
}
