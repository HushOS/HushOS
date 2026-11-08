import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    encryptWebPush,
    isPushEndpoint,
    isSubscriptionKey,
    makeVapidKeys,
    sendWebPush,
    vapidAuthorization,
    vapidKeys,
} from './webpush';

/*
 * Web Push's encryption and signing (RFC 8291, RFC 8292). A mistake here is a push no browser can
 * open, or one any party could forge or point anywhere; each test fails on one.
 */

const b = (text: string) => Buffer.from(text, 'base64url');

/* The browser's side, as a push service hands the body over: what it opens is what was sent. */
function open(body: Buffer, uaPrivate: Buffer, auth: Buffer) {
    const salt = body.subarray(0, 16);
    const idLength = body.readUInt8(20);
    const senderPublic = body.subarray(21, 21 + idLength);
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(uaPrivate);
    const ecdh = ua.computeSecret(senderPublic);
    const hk = (s: Buffer, ikm: Buffer, info: Buffer, n: number) =>
        createHmac('sha256', createHmac('sha256', s).update(ikm).digest())
            .update(Buffer.concat([info, Buffer.from([1])]))
            .digest()
            .subarray(0, n);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), senderPublic]);
    const ikm = hk(auth, ecdh, info, 32);
    const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    const sealed = body.subarray(21 + idLength);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    expect(padded.at(-1)).toBe(2);
    return padded.subarray(0, -1);
}

describe('RFC 8291 encryption', () => {
    // RFC 8291 Appendix A, character for character.
    const vector = {
        plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
        asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        uaPublic:
            'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
        salt: 'DGv6ra1nlYgDCS1FRnbzlw',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        // The header (salt, record size, sender key) and the ciphertext, as the appendix prints them.
        header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
        ciphertext:
            '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
    };

    test('reproduces the RFC’s example exactly', () => {
        const body = encryptWebPush({
            plaintext: b(vector.plaintext),
            p256dh: b(vector.uaPublic),
            auth: b(vector.auth),
            senderPrivate: b(vector.asPrivate),
            salt: b(vector.salt),
        });
        // The body is the header's bytes then the ciphertext's.
        expect(body).toEqual(Buffer.concat([b(vector.header), b(vector.ciphertext)]));
    });

    test('a fresh message opens with the browser’s keys, and every one differs', () => {
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        const auth = Buffer.alloc(16, 9);
        const message = Buffer.from('{"id":"6f1c6a8e-2c7b-4b2f-9a0d-3c1e8f7a5b42"}');
        const one = encryptWebPush({ plaintext: message, p256dh: ua.getPublicKey(), auth });
        const two = encryptWebPush({ plaintext: message, p256dh: ua.getPublicKey(), auth });
        expect(open(one, ua.getPrivateKey(), auth)).toEqual(message);
        expect(one.equals(two)).toBe(false);
        // Another browser's auth secret cannot open it.
        expect(() => open(one, ua.getPrivateKey(), Buffer.alloc(16, 8))).toThrow();
    });

    test('refuses keys that are not a subscription’s', () => {
        expect(() =>
            encryptWebPush({
                plaintext: Buffer.from('x'),
                p256dh: Buffer.alloc(33),
                auth: Buffer.alloc(16),
            }),
        ).toThrow();
        expect(() =>
            encryptWebPush({
                plaintext: Buffer.from('x'),
                p256dh: b(vector.uaPublic),
                auth: Buffer.alloc(8),
            }),
        ).toThrow();
    });
});

describe('VAPID', () => {
    test('signs a token for the push service’s origin that verifies with the public key', () => {
        const stored = makeVapidKeys();
        const keys = vapidKeys(stored);
        const now = Date.UTC(2026, 10, 9);
        const header = vapidAuthorization(
            keys,
            'https://fcm.googleapis.com/fcm/send/abc',
            'https://hushos.com',
            now,
        );
        const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
        expect(match[4]).toBe(stored.publicKey);
        const claims = JSON.parse(b(match[2]!).toString());
        expect(claims).toEqual({
            aud: 'https://fcm.googleapis.com',
            exp: now / 1000 + 12 * 60 * 60,
            sub: 'https://hushos.com',
        });
        const point = b(stored.publicKey);
        const publicKey = createPublicKey({
            format: 'jwk',
            key: {
                kty: 'EC',
                crv: 'P-256',
                x: point.subarray(1, 33).toString('base64url'),
                y: point.subarray(33).toString('base64url'),
            },
        });
        const signed = Buffer.from(`${match[1]}.${match[2]}`);
        expect(
            verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(match[3]!)),
        ).toBe(true);
        // Another server's key does not verify it.
        const other = makeVapidKeys();
        const otherPoint = b(other.publicKey);
        const otherKey = createPublicKey({
            format: 'jwk',
            key: {
                kty: 'EC',
                crv: 'P-256',
                x: otherPoint.subarray(1, 33).toString('base64url'),
                y: otherPoint.subarray(33).toString('base64url'),
            },
        });
        expect(
            verify('sha256', signed, { key: otherKey, dsaEncoding: 'ieee-p1363' }, b(match[3]!)),
        ).toBe(false);
    });
});

describe('push endpoints', () => {
    test('only the browsers’ push services, over plain HTTPS', () => {
        for (const ok of [
            'https://fcm.googleapis.com/fcm/send/dXk',
            'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
            'https://web.push.apple.com/QGx',
            'https://api.push.apple.com/3/device/x',
            'https://wns2-par02p.notify.windows.com/w/?token=x',
        ])
            expect(isPushEndpoint(ok), ok).toBe(true);
        for (const bad of [
            'http://fcm.googleapis.com/fcm/send/dXk',
            'https://fcm.googleapis.com:8443/fcm/send/dXk',
            'https://evil.example/fcm.googleapis.com',
            'https://fcm.googleapis.com.evil.example/x',
            'https://push.apple.com.evil.example/x',
            'https://evil.example/push.apple.com',
            'https://user:pass@fcm.googleapis.com/x',
            'https://localhost/x',
            'https://169.254.169.254/latest',
            'not a url',
            `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
        ])
            expect(isPushEndpoint(bad), bad).toBe(false);
    });
});

describe('subscription keys', () => {
    test('only a point on P-256 and a 16-byte secret', () => {
        const ua = createECDH('prime256v1');
        ua.generateKeys();
        const point = ua.getPublicKey();
        const auth = Buffer.alloc(16, 1).toString('base64url');
        expect(isSubscriptionKey(point.toString('base64url'), auth)).toBe(true);
        // 65 bytes and the right prefix, but off the curve: encrypting to it would throw.
        const off = Buffer.from(point);
        off[64] = off[64]! ^ 1;
        expect(isSubscriptionKey(off.toString('base64url'), auth)).toBe(false);
        expect(
            isSubscriptionKey(point.toString('base64url'), Buffer.alloc(8).toString('base64url')),
        ).toBe(false);
        // A compressed point is not what browsers hand over.
        expect(
            isSubscriptionKey(
                Buffer.from(ua.getPublicKey(null, 'compressed')).toString('base64url'),
                auth,
            ),
        ).toBe(false);
    });
});

describe('sending', () => {
    const keys = vapidKeys(makeVapidKeys());
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        p256dh: ua.getPublicKey().toString('base64url'),
        auth: Buffer.alloc(16, 3).toString('base64url'),
    };
    const id = '6f1c6a8e-2c7b-4b2f-9a0d-3c1e8f7a5b42';

    afterEach(() => vi.unstubAllGlobals());

    function answering(status: number) {
        const fetch = vi.fn(async () => new Response(null, { status }));
        vi.stubGlobal('fetch', fetch);
        return fetch;
    }

    test('a dropped subscription is gone; a refusal or an outage is only a failure', async () => {
        answering(201);
        expect(await sendWebPush(keys, 'https://hushos.com', subscription, id, 'normal')).toBe(
            'delivered',
        );
        for (const status of [404, 410]) {
            answering(status);
            expect(await sendWebPush(keys, 'https://hushos.com', subscription, id, 'normal')).toBe(
                'gone',
            );
        }
        // A wrong VAPID key or a push service outage must not delete the person's subscription.
        for (const status of [401, 403, 429, 500, 503]) {
            answering(status);
            expect(await sendWebPush(keys, 'https://hushos.com', subscription, id, 'normal')).toBe(
                'failed',
            );
        }
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Promise.reject(new TypeError('network'))),
        );
        expect(await sendWebPush(keys, 'https://hushos.com', subscription, id, 'normal')).toBe(
            'failed',
        );
    });

    test('what goes out opens to the event id, for the browser that subscribed', async () => {
        const fetch = answering(201);
        await sendWebPush(keys, 'https://hushos.com', subscription, id, 'high');
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(subscription.endpoint);
        const body = Buffer.from(init.body as Uint8Array);
        const opened = open(body, ua.getPrivateKey(), b(subscription.auth));
        expect(JSON.parse(opened.toString())).toEqual({ id });
    });

    test('a stored key off the curve is dropped as gone, and nothing is sent', async () => {
        const fetch = answering(201);
        const off = b(subscription.p256dh);
        off[64] = off[64]! ^ 1;
        expect(
            await sendWebPush(
                keys,
                'https://hushos.com',
                { ...subscription, p256dh: off.toString('base64url') },
                id,
                'normal',
            ),
        ).toBe('gone');
        expect(
            await sendWebPush(
                keys,
                'https://hushos.com',
                { ...subscription, endpoint: 'https://evil.example/x' },
                id,
                'normal',
            ),
        ).toBe('gone');
        expect(fetch).not.toHaveBeenCalled();
    });
});
