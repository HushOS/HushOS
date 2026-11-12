import { describe, expect, test } from 'vitest';
import { readLoginReply } from './login-reply';

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

    test('a step offers only what this client can answer', () => {
        // A security key, which this client cannot use yet, is not offered.
        expect(
            readLoginReply({ twoStep: { ...step(), methods: ['webauthn', 'totp'] } }),
        ).toMatchObject({ kind: 'step', challenge: { methods: ['totp'] } });
        // The phrase cannot sign without the salt, whatever the list says.
        const withoutSalt = readLoginReply({ twoStep: { ...step(), phrase: undefined } });
        expect(withoutSalt).toMatchObject({
            kind: 'step',
            challenge: { methods: ['totp', 'backup'] },
        });
        expect(withoutSalt.kind === 'step' && withoutSalt.challenge.phrase).toBeUndefined();
        // Nothing it can answer is still a step: the page says to update, it does not sign in.
        expect(
            readLoginReply({ twoStep: { ...step(), methods: ['webauthn'], phrase: undefined } }),
        ).toEqual({
            kind: 'step',
            challenge: { token: TOKEN, methods: [], expiresAt: step().expiresAt },
        });
    });
});
