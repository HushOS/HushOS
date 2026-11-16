import { describe, expect, test } from 'vitest';
import { readKeyAdded, readKeyOptions, readLoginReply } from './login-reply';

/*
 * Reading a sign-in's reply. The defect this guards against: a 200 that is not the server's
 * own answer (a captive portal's page, a proxy's error document, a body cut short) being
 * taken for a sign-in, which strands the person on a page that believes it is signed in and
 * has no key to open; or being taken for a step that can never be answered.
 */

const TOKEN = 'a-step-token_'.padEnd(43, 'x');
const session = () => ({
    user: { id: 'user-1', email: 'maya@hush.example', name: 'Maya', credentialVersion: 1 },
    envelope: {
        envelopeVersion: 1,
        keyVersion: 1,
        credentialVersion: 1,
        wrappingSalt: 'c2FsdA',
        wrappingNonce: 'bm9uY2U',
        encryptedKey: 'a2V5',
    },
    device: { id: 'device-1', attached: false, registered: false },
});
const step = () => ({
    token: TOKEN,
    methods: ['totp', 'backup', 'phrase'],
    expiresAt: '2026-11-13T10:05:00.000Z',
    phrase: { userId: 'user-1', recoveryVersion: 1, wrappingSalt: 'c2FsdA' },
});

describe('a sign-in’s reply', () => {
    test('the server’s two answers are read as what they are', () => {
        const signedIn = session();
        expect(readLoginReply(signedIn)).toEqual({ kind: 'session', session: signedIn });
        expect(readLoginReply({ twoStep: step() })).toEqual({ kind: 'step', challenge: step() });
        // The web's API client turns the server's times into Dates before anyone reads them.
        expect(
            readLoginReply({ twoStep: { ...step(), expiresAt: new Date(step().expiresAt) } }),
        ).toEqual({ kind: 'step', challenge: step() });
        expect(readLoginReply({ twoStep: { ...step(), expiresAt: new Date(Number.NaN) } })).toEqual(
            { kind: 'lost' },
        );
        expect(TOKEN).toHaveLength(43);
    });

    test.each([
        ['a proxy’s page', '<!doctype html><title>Sign in to the network</title>'],
        ['an empty body', null],
        ['nothing', undefined],
        ['an empty object', {}],
        ['a list', [session()]],
        ['a success flag alone', { success: true }],
        ['a user without an envelope', { ...session(), envelope: undefined }],
        [
            'an envelope without its key',
            { ...session(), envelope: { ...session().envelope, encryptedKey: '' } },
        ],
        ['a user without an id', { ...session(), user: { email: 'maya@hush.example' } }],
        ['no device', { ...session(), device: null }],
        ['a step without a token', { twoStep: { ...step(), token: undefined } }],
        ['a step whose token is not a token', { twoStep: { ...step(), token: 'short' } }],
        ['a step without methods', { twoStep: { ...step(), methods: undefined } }],
        ['a step without an end', { twoStep: { ...step(), expiresAt: 'soon' } }],
        ['a step that is only a flag', { twoStep: true }],
        ['both a session and a step', { ...session(), twoStep: step() }],
    ])('%s is a lost reply, never a sign-in or a step', (_name, reply) => {
        expect(readLoginReply(reply)).toEqual({ kind: 'lost' });
    });

    const keys = () => ({
        challenge: 'Y2hhbGxlbmdl',
        rpId: 'hushos.com',
        timeout: 300_000,
        userVerification: 'discouraged',
        allowCredentials: [{ id: 'a2V5', type: 'public-key', transports: ['usb'] }],
    });

    test('a step offers only what this client can answer', () => {
        // Another device needs nothing the reply carries, and keeps the server's place for it.
        expect(readLoginReply({ twoStep: { ...step(), methods: ['device', 'totp'] } })).toEqual({
            kind: 'step',
            challenge: { ...step(), methods: ['device', 'totp'] },
        });
        // A way this client does not know is not offered; and since the server put it first,
        // the account's usual way is not on offer here.
        expect(
            readLoginReply({ twoStep: { ...step(), methods: ['a-way-from-later', 'totp'] } }),
        ).toEqual({
            kind: 'step',
            challenge: { ...step(), methods: ['totp'], defaultUnavailable: true },
        });
        // The phrase cannot sign without the salt, whatever the list says.
        const withoutSalt = readLoginReply({ twoStep: { ...step(), phrase: undefined } });
        expect(withoutSalt).toMatchObject({
            kind: 'step',
            challenge: { methods: ['totp', 'backup'] },
        });
        expect(withoutSalt.kind === 'step' && withoutSalt.challenge.phrase).toBeUndefined();
        // Nor can a key answer without its challenge and the keys to ask.
        for (const webauthn of [
            undefined,
            { ...keys(), challenge: '' },
            { ...keys(), allowCredentials: [] },
        ])
            expect(
                readLoginReply({
                    twoStep: { ...step(), methods: ['webauthn', 'totp'], webauthn },
                }),
            ).toEqual({
                kind: 'step',
                challenge: {
                    token: TOKEN,
                    methods: ['totp'],
                    expiresAt: step().expiresAt,
                    phrase: step().phrase,
                    defaultUnavailable: true,
                },
            });
        // Nothing it can answer is still a step: the page says to update, it does not sign in.
        expect(
            readLoginReply({
                twoStep: { ...step(), methods: ['a-way-from-later'], phrase: undefined },
            }),
        ).toEqual({
            kind: 'step',
            challenge: {
                token: TOKEN,
                methods: [],
                expiresAt: step().expiresAt,
                defaultUnavailable: true,
            },
        });
    });

    test('the order is the server’s: the account’s usual way stays first', () => {
        const read = (methods: string[], extra: Record<string, unknown> = {}) => {
            const reply = readLoginReply({
                twoStep: { ...step(), methods, webauthn: keys(), ...extra },
            });
            if (reply.kind !== 'step') throw new Error('Not a step.');
            return reply.challenge;
        };
        // An account whose default is its app is not opened on its passkey, nor the reverse.
        expect(read(['totp', 'webauthn', 'backup', 'phrase']).methods).toEqual([
            'totp',
            'webauthn',
            'backup',
            'phrase',
        ]);
        const keyFirst = read(['webauthn', 'totp', 'backup', 'phrase']);
        expect(keyFirst.methods[0]).toBe('webauthn');
        expect(keyFirst.webauthn).toEqual(keys());
        expect(keyFirst.defaultUnavailable).toBeUndefined();
        expect(keyFirst.withheld).toBeUndefined();
        // A method listed twice is offered once.
        expect(read(['totp', 'totp', 'backup']).methods).toEqual(['totp', 'backup']);
        // What the server says about its list is kept; anything but `true` is not a yes.
        expect(read(['totp'], { withheld: true, defaultUnavailable: true })).toMatchObject({
            withheld: true,
            defaultUnavailable: true,
        });
        const loose = read(['totp'], { withheld: 'no', defaultUnavailable: 1 });
        expect(loose.withheld).toBeUndefined();
        expect(loose.defaultUnavailable).toBeUndefined();
        // A key's options are not handed on when no key is on offer.
        expect(read(['totp', 'backup']).webauthn).toBeUndefined();
    });
});

describe('a key being added', () => {
    const REGISTRATION = 'a-registration_'.padEnd(43, 'y');
    const options = () => ({
        challenge: 'Y2hhbGxlbmdl',
        rp: { id: 'hushos.com', name: 'HushOS' },
        user: { id: 'aGFuZGxl', name: 'maya@hush.example', displayName: 'maya@hush.example' },
        pubKeyCredParams: [
            { type: 'public-key', alg: -8 },
            { type: 'public-key', alg: -7 },
        ],
        timeout: 300_000,
        attestation: 'none',
        excludeCredentials: [{ id: 'a2V5', type: 'public-key' }],
        authenticatorSelection: {
            residentKey: 'discouraged',
            userVerification: 'discouraged',
            requireResidentKey: false,
        },
    });
    const method = () => ({
        id: 'factor-1',
        kind: 'webauthn',
        name: 'Security key',
        createdAt: '2026-11-13T10:00:00.000Z',
        lastUsedAt: null,
        synced: false,
    });

    test('the server’s options are read whole, and a reply short of them is not one', () => {
        expect(readKeyOptions({ registrationToken: REGISTRATION, options: options() })).toEqual({
            registrationToken: REGISTRATION,
            options: options(),
        });
        for (const reply of [
            null,
            '<!doctype html>',
            {},
            { registrationToken: REGISTRATION },
            { registrationToken: 'short', options: options() },
            { registrationToken: REGISTRATION, options: { ...options(), challenge: '' } },
            { registrationToken: REGISTRATION, options: { ...options(), rp: { name: 'HushOS' } } },
            { registrationToken: REGISTRATION, options: { ...options(), user: null } },
            { registrationToken: REGISTRATION, options: { ...options(), pubKeyCredParams: [] } },
            {
                registrationToken: REGISTRATION,
                options: { ...options(), excludeCredentials: [{ id: 'a2V5', type: 'password' }] },
            },
        ])
            expect(readKeyOptions(reply)).toBeNull();
    });

    test('a key is never asked for more than a second step needs, whatever a reply says', () => {
        const read = readKeyOptions({
            registrationToken: REGISTRATION,
            options: {
                ...options(),
                attestation: 'direct',
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            },
        });
        expect(read?.options.attestation).toBe('none');
        expect(read?.options.authenticatorSelection).toEqual({
            residentKey: 'discouraged',
            userVerification: 'discouraged',
            requireResidentKey: false,
        });
    });

    test('only the server’s own answer says a key was added, with codes exactly when it sent them', () => {
        expect(readKeyAdded({ method: method() })).toEqual({ method: method() });
        expect(readKeyAdded({ method: method(), backupCodes: ['7KQ2M-9XD4P'] })).toEqual({
            method: method(),
            backupCodes: ['7KQ2M-9XD4P'],
        });
        // The web's API client turns the server's times into Dates before anyone reads them.
        expect(
            readKeyAdded({
                method: {
                    ...method(),
                    createdAt: new Date(method().createdAt),
                    lastUsedAt: new Date('2026-11-13T11:00:00.000Z'),
                },
            }),
        ).toEqual({ method: { ...method(), lastUsedAt: '2026-11-13T11:00:00.000Z' } });
        for (const reply of [
            null,
            {},
            { success: true },
            { method: { ...method(), createdAt: new Date(Number.NaN) } },
            { method: { ...method(), createdAt: 'soon' } },
            { method: { ...method(), kind: 'totp' } },
            { method: { ...method(), id: '' } },
            { method: method(), backupCodes: [] },
            { method: method(), backupCodes: 'none' },
        ])
            expect(readKeyAdded(reply)).toBeNull();
    });
});
