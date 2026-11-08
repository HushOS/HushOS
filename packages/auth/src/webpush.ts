import {
    createCipheriv,
    createECDH,
    createHmac,
    createPrivateKey,
    randomBytes,
    sign,
    type KeyObject,
} from 'node:crypto';

/*
 * Web Push (docs/devices-design.md 5): a browser's subscription is an endpoint at its push service
 * and two keys. The payload is encrypted to the browser (RFC 8291, aes128gcm) and the request is
 * signed with this server's VAPID key (RFC 8292). The payload is the event id only; the service
 * worker never opens anything else.
 */

export type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url');

function hmac(key: Uint8Array, ...parts: Uint8Array[]) {
    const mac = createHmac('sha256', key);
    for (const part of parts) mac.update(part);
    return mac.digest();
}

/* HKDF with SHA-256 for at most one block of output, as RFC 8291 and RFC 8188 use it. */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
    const prk = hmac(salt, ikm);
    return hmac(prk, info, Buffer.from([1])).subarray(0, length);
}

const RECORD_SIZE = 4096;

/*
 * Encrypts `plaintext` to a browser's keys as one aes128gcm record (RFC 8291 3.4). The sender key
 * pair and salt are fresh for every message; a test passes fixed ones to check the RFC's example.
 */
export function encryptWebPush(input: {
    plaintext: Uint8Array;
    p256dh: Uint8Array;
    auth: Uint8Array;
    senderPrivate?: Uint8Array;
    salt?: Uint8Array;
}) {
    if (input.p256dh.length !== 65 || input.auth.length !== 16)
        throw new Error('Not a Web Push subscription key.');
    const sender = createECDH('prime256v1');
    if (input.senderPrivate) sender.setPrivateKey(Buffer.from(input.senderPrivate));
    else sender.generateKeys();
    const senderPublic = sender.getPublicKey();
    const salt = input.salt ?? randomBytes(16);
    const ecdh = sender.computeSecret(Buffer.from(input.p256dh));
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), input.p256dh, senderPublic]);
    const ikm = hkdf(input.auth, ecdh, keyInfo, 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    // One record: the plaintext, then the last-record delimiter.
    const padded = Buffer.concat([input.plaintext, Buffer.from([2])]);
    if (padded.length + 16 > RECORD_SIZE) throw new Error('Too much for one Web Push record.');
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(16 + 4 + 1);
    Buffer.from(salt).copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(senderPublic.length, 20);
    return Buffer.concat([header, senderPublic, sealed]);
}

/* A VAPID key pair: the private key for signing, and the public key browsers subscribe with. */
export type VapidKeys = { privateKey: KeyObject; publicKey: string };

/* Makes a P-256 key pair for VAPID, as the server does once, at first start. */
export function makeVapidKeys() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { privateKey: b64(ecdh.getPrivateKey()), publicKey: b64(ecdh.getPublicKey()) };
}

/* The stored pair as a signing key: the private scalar, with the public point it belongs to. */
export function vapidKeys(stored: { privateKey: string; publicKey: string }): VapidKeys {
    const point = unb64(stored.publicKey);
    if (point.length !== 65 || point[0] !== 4) throw new Error('Not a VAPID public key.');
    const privateKey = createPrivateKey({
        format: 'jwk',
        key: {
            kty: 'EC',
            crv: 'P-256',
            d: stored.privateKey,
            x: b64(point.subarray(1, 33)),
            y: b64(point.subarray(33)),
        },
    });
    return { privateKey, publicKey: stored.publicKey };
}

/*
 * The Authorization header for one push service (RFC 8292): a JWT for that service's origin,
 * valid 12 hours, naming this server as the contact.
 */
export function vapidAuthorization(
    keys: VapidKeys,
    endpoint: string,
    subject: string,
    now = Date.now(),
) {
    const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64(
        Buffer.from(
            JSON.stringify({
                aud: new URL(endpoint).origin,
                exp: Math.floor(now / 1000) + 12 * 60 * 60,
                sub: subject,
            }),
        ),
    );
    const signed = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(signed), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363',
    });
    return `vapid t=${signed}.${b64(signature)}, k=${keys.publicKey}`;
}

/*
 * The push services a subscription may point at: the major browsers' own, over HTTPS. Anything
 * else would have this server send requests wherever a client said.
 */
const PUSH_HOSTS = [
    /^fcm\.googleapis\.com$/,
    /^updates\.push\.services\.mozilla\.com$/,
    /^web\.push\.apple\.com$/,
    /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string) {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    return (
        url.protocol === 'https:' &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        endpoint.length <= 1024 &&
        PUSH_HOSTS.some((host) => host.test(url.hostname))
    );
}

export type WebPushOutcome = 'delivered' | 'gone' | 'failed';

/*
 * Sends one push: the event id, encrypted to the browser. A 404 or 410 means the subscription is
 * gone (the browser unsubscribed or the push service dropped it); anything else that is not a
 * success is a failure the device recovers from when it next lists.
 */
export async function sendWebPush(
    keys: VapidKeys,
    subject: string,
    subscription: WebPushSubscription,
    id: string,
    urgency: 'high' | 'normal',
): Promise<WebPushOutcome> {
    if (!isPushEndpoint(subscription.endpoint)) return 'gone';
    const body = encryptWebPush({
        plaintext: Buffer.from(JSON.stringify({ id })),
        p256dh: unb64(subscription.p256dh),
        auth: unb64(subscription.auth),
    });
    try {
        const response = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
                authorization: vapidAuthorization(keys, subscription.endpoint, subject),
                'content-encoding': 'aes128gcm',
                'content-type': 'application/octet-stream',
                ttl: String(24 * 60 * 60),
                urgency,
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
        if (response.status === 404 || response.status === 410) return 'gone';
        return response.ok ? 'delivered' : 'failed';
    } catch {
        return 'failed';
    }
}
