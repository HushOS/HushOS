import type { WideEvent } from 'evlog';
import { describe, expect, test } from 'vitest';
import { authLogAction, redactAuthenticationEvent, sanitizeFailure } from './privacy';

/*
 * Logs leave the machine, so what reaches them on a private route is an
 * allowlist: a fixed set of fields, a path with nothing of the visitor's in it,
 * and of a failure only its class and machine code. Everything here feeds the
 * transform what a careless handler or a hostile request could, and reads what
 * would be written.
 */

const ADDRESS = 'ada@example.com';
const TOKEN = 'v3rify-t0ken-5e1f';
const FOLDER = '3f0c9a52-6f0e-4b53-9d0a-0c1d2e3f4a5b';

function redact(event: Record<string, unknown>) {
    const wide = { timestamp: '2026-09-22T10:00:00.000Z', level: 'info', ...event } as WideEvent;
    redactAuthenticationEvent(wide);
    return wide as Record<string, unknown>;
}

describe('paths', () => {
    test('a verification token in the query string never reaches the log', () => {
        const event = redact({ path: `/api/auth/register/verify?token=${TOKEN}` });
        expect(event.path).toBe('/api/auth/register/verify');
        expect(JSON.stringify(event)).not.toContain(TOKEN);
    });

    test('a query string is dropped on public routes too', () => {
        const event = redact({ path: `/pricing?ref=${ADDRESS}#${TOKEN}` });
        expect(event.path).toBe('/pricing');
    });

    test('an auth path the API does not define is logged as unknown, not echoed', () => {
        expect(redact({ path: `/api/auth/identity/${FOLDER}` }).path).toBe('/api/auth/unknown');
        expect(redact({ path: `/api/auth/${ADDRESS}` }).path).toBe('/api/auth/unknown');
        expect(authLogAction('/api/auth/login/start/extra')).toBe('unknown');
    });

    test('a page that carries an identifier is logged as its pattern', () => {
        expect(redact({ path: `/app/drive/f/${FOLDER}` }).path).toBe('/app/drive/f/:folderId');
        expect(redact({ path: `/app/tags/${FOLDER}` }).path).toBe('/app/tags/:tagId');
        expect(redact({ path: `/app/admin/reports/${FOLDER}` }).path).toBe(
            '/app/admin/reports/:reportId',
        );
    });

    test('a private page nobody listed is unknown, however it is nested', () => {
        expect(redact({ path: `/app/${ADDRESS}` }).path).toBe('/private/unknown');
        expect(redact({ path: `/app/drive/f/${FOLDER}/${ADDRESS}` }).path).toBe('/private/unknown');
        expect(redact({ path: `/register/${TOKEN}` }).path).toBe('/private/unknown');
    });

    test('a route that only starts like a private one keeps its fields', () => {
        const event = redact({ path: '/application', campaign: 'spring' });
        expect(event.path).toBe('/application');
        expect(event.campaign).toBe('spring');
    });
});

describe('fields on a private route', () => {
    test('anything a handler attached beyond the allowlist is removed', () => {
        const event = redact({
            path: '/api/auth/login/start',
            method: 'POST',
            status: 200,
            requestId: 'r-1',
            user: { email: ADDRESS },
            startLoginRequest: TOKEN,
            note: ADDRESS,
        });
        expect(event).toEqual({
            timestamp: '2026-09-22T10:00:00.000Z',
            level: 'info',
            path: '/api/auth/login/start',
            method: 'POST',
            status: 200,
            requestId: 'r-1',
        });
    });

    test('the pages of the app are held to the same allowlist as the API', () => {
        const event = redact({ path: '/app/account', user: { email: ADDRESS } });
        expect(event.path).toBe('/app/account');
        expect(JSON.stringify(event)).not.toContain(ADDRESS);
    });
});

describe('the auth block', () => {
    test('free text in the action or outcome collapses to unknown', () => {
        const event = redact({
            path: '/api/auth/login/finish',
            auth: {
                action: `login for ${ADDRESS}`,
                outcome: `rejected ${ADDRESS}`,
                email: ADDRESS,
            },
        });
        expect(event.auth).toEqual({ action: 'unknown', outcome: 'unknown' });
    });

    test('a listed action and outcome pass through', () => {
        const event = redact({
            path: '/api/auth/identity/kem',
            auth: { action: 'identity/kem', outcome: 'rejected' },
        });
        expect(event.path).toBe('/api/auth/identity/kem');
        expect(event.auth).toEqual({ action: 'identity/kem', outcome: 'rejected' });
    });

    test('an auth value that is not an object is removed', () => {
        expect(redact({ path: '/api/auth/session', auth: ADDRESS })).not.toHaveProperty('auth');
    });

    test('of a failure only the class and machine code survive, down the cause chain', () => {
        const cause = Object.assign(new Error(`no grant for ${ADDRESS}`), { code: '42501' });
        const failure = Object.assign(new Error(`could not mail ${ADDRESS}`, { cause }), {
            name: 'SmtpError',
            code: 'EENVELOPE',
        });
        const event = redact({
            path: '/api/auth/register/email',
            auth: { action: 'register/email', outcome: 'unavailable', failure },
        });
        expect(event.auth).toEqual({
            action: 'register/email',
            outcome: 'unavailable',
            failure: {
                kind: 'SmtpError',
                code: 'EENVELOPE',
                cause: { kind: 'Error', code: '42501' },
            },
        });
        expect(JSON.stringify(event)).not.toContain(ADDRESS);
    });

    test('a class name or code that could carry an address is not trusted', () => {
        expect(sanitizeFailure({ name: `Bounce <${ADDRESS}>`, code: `to ${ADDRESS}` })).toEqual({
            kind: 'unknown',
        });
        expect(sanitizeFailure({ name: 'E'.repeat(65) })).toEqual({ kind: 'unknown' });
    });

    test('a failure that is its own cause ends instead of recursing', () => {
        const loop: { name: string; cause?: unknown } = { name: 'LoopError' };
        loop.cause = loop;
        expect(sanitizeFailure(loop)).toEqual({ kind: 'LoopError' });
    });
});
