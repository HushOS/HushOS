import {
    createHash,
    createSign,
    generateKeyPairSync,
    randomBytes,
    type KeyObject,
} from 'node:crypto';

/*
 * A security key in software, for tests: an ES256 credential that answers WebAuthn's two
 * ceremonies the way a browser hands them over (RegistrationResponseJSON,
 * AuthenticationResponseJSON). Everything a real key and browser decide, a test can decide
 * here instead (the origin and RP ID it claims, its counter, whether a person was present,
 * whether it is synced), so the server's checks are exercised with answers that are right
 * in every way but one. The private key never leaves this object.
 */

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest();

/* CBOR, as much of it as an attestation object and a COSE key need. */
function head(major: number, value: number) {
    const type = major << 5;
    if (value < 24) return Buffer.from([type | value]);
    if (value < 256) return Buffer.from([type | 24, value]);
    return Buffer.from([type | 25, value >> 8, value & 255]);
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(value: Cbor): Buffer {
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === 'string') {
        const text = Buffer.from(value, 'utf8');
        return Buffer.concat([head(3, text.length), text]);
    }
    if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
    return Buffer.concat([
        head(5, value.size),
        ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)]),
    ]);
}

const FLAG = { present: 0x01, backupEligible: 0x08, backedUp: 0x10, attested: 0x40 } as const;

export type SoftKeyOptions = {
    /* What the key's browser says its page is; a real browser cannot lie about it. */
    origin?: string;
    rpId?: string;
    /* A passkey a password manager syncs: backup-eligible and backed up, counter always 0. */
    synced?: boolean;
    /* The counter its next answer carries; a hardware key counts up from 1. */
    counter?: number;
};
/* What one answer does differently from the key's own settings. */
export type AnswerOverrides = SoftKeyOptions & {
    /* Nobody touched the key. */
    absent?: boolean;
    /* The ceremony the client data names, when it is not the one asked. */
    type?: string;
    /* The challenge signed, when it is not the one the options carry. */
    challenge?: string;
    /* The client data says the page was framed by another site. */
    crossOrigin?: boolean;
};

export function softKey(options: SoftKeyOptions = {}) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = randomBytes(32);
    const settings = { origin: 'http://localhost:5173', rpId: 'localhost', ...options };
    let counter = options.counter ?? (options.synced ? 0 : 1);

    const cose = cbor(
        new Map<number, Cbor>([
            [1, 2], // kty: EC2
            [3, -7], // alg: ES256
            [-1, 1], // crv: P-256
            [-2, Buffer.from(jwk.x!, 'base64url')],
            [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
    );

    function authenticatorData(use: AnswerOverrides, attested: boolean) {
        const synced = use.synced ?? settings.synced ?? false;
        const flags =
            (use.absent ? 0 : FLAG.present) |
            (synced ? FLAG.backupEligible | FLAG.backedUp : 0) |
            (attested ? FLAG.attested : 0);
        const count = Buffer.alloc(4);
        count.writeUInt32BE(use.counter ?? (synced ? 0 : counter));
        const length = Buffer.alloc(2);
        length.writeUInt16BE(credentialId.length);
        return Buffer.concat([
            sha256(use.rpId ?? settings.rpId),
            Buffer.from([flags]),
            count,
            ...(attested ? [Buffer.alloc(16), length, credentialId, cose] : []),
        ]);
    }
    function clientData(type: string, challenge: string, use: AnswerOverrides) {
        return Buffer.from(
            JSON.stringify({
                type: use.type ?? type,
                challenge: use.challenge ?? challenge,
                origin: use.origin ?? settings.origin,
                crossOrigin: use.crossOrigin ?? false,
            }),
        );
    }

    return {
        id: b64(credentialId),
        /* What `navigator.credentials.create` resolves with, for the options the server sent. */
        register(creation: { challenge: string }, use: AnswerOverrides = {}) {
            const authData = authenticatorData(use, true);
            // Being added is a use too: a hardware key's next answer counts one higher.
            if (use.counter === undefined) counter += 1;
            const attestationObject = cbor(
                new Map<string, Cbor>([
                    ['fmt', 'none'],
                    ['attStmt', new Map()],
                    ['authData', authData],
                ]),
            );
            return {
                id: b64(credentialId),
                rawId: b64(credentialId),
                type: 'public-key' as const,
                response: {
                    clientDataJSON: b64(clientData('webauthn.create', creation.challenge, use)),
                    attestationObject: b64(attestationObject),
                    transports: ['usb'],
                },
            };
        },
        /* What `navigator.credentials.get` resolves with. Each answer moves a hardware key's counter on. */
        assert(request: { challenge: string }, use: AnswerOverrides = {}) {
            const authData = authenticatorData(use, false);
            const data = clientData('webauthn.get', request.challenge, use);
            if (use.counter === undefined) counter += 1;
            return {
                id: b64(credentialId),
                rawId: b64(credentialId),
                type: 'public-key' as const,
                response: {
                    clientDataJSON: b64(data),
                    authenticatorData: b64(authData),
                    signature: b64(sign(privateKey, Buffer.concat([authData, sha256(data)]))),
                },
            };
        },
    };
}
export type SoftKey = ReturnType<typeof softKey>;

/* ES256 as WebAuthn carries it: an ASN.1 DER signature over SHA-256. */
function sign(key: KeyObject, data: Uint8Array) {
    return createSign('sha256').update(data).sign(key);
}
