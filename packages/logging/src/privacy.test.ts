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

    test('a contact’s succession chain is logged as its pattern, never the account it names', () => {
        expect(redact({ path: `/api/auth/contacts/${FOLDER}/succession?from=2` }).path).toBe(
            '/api/auth/contacts/:userId/succession',
        );
        expect(authLogAction(`/api/auth/contacts/${FOLDER}/succession/extra`)).toBe('unknown');
    });

    test('a device is logged as its pattern, never its id, and nothing below it is served', () => {
        const logged = redact({ path: `/api/auth/devices/${FOLDER}` }).path;
        expect(logged).toBe('/api/auth/devices/:id');
        expect(String(logged)).not.toContain(FOLDER);
        // Unknown paths answer 404 before their body is read; a longer one must stay unknown.
        expect(authLogAction(`/api/auth/devices/${FOLDER}/extra`)).toBe('unknown');
        expect(authLogAction(`/api/auth/devices/${FOLDER}x`)).toBe('unknown');
        expect(authLogAction('/api/auth/devices/others')).toBe('devices/others');
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

    test('a link token in the path never reaches the log, on the page or the API', () => {
        expect(redact({ path: `/s/${TOKEN}` }).path).toBe('/s/:token');
        expect(redact({ path: `/api/drive/links/${TOKEN}/open` }).path).toBe(
            '/api/drive/links/:link/open',
        );
        expect(redact({ path: `/api/drive/links/${TOKEN}/versions/${FOLDER}/url` }).path).toBe(
            `/api/drive/links/:link/versions/${FOLDER}/url`,
        );
    });

    test('a link page the router serves under another spelling is redacted too', () => {
        for (const path of [
            `/S/${TOKEN}`,
            `/%73/${TOKEN}`,
            `//s/${TOKEN}`,
            `/s/${TOKEN}/`,
            `/s/${TOKEN}/x`,
        ]) {
            const event = redact({ path });
            expect(event.path, path).toBe('/s/:token');
            expect(JSON.stringify(event)).not.toContain(TOKEN);
        }
        // An app page in capitals is still a private page, held to the allowlist.
        const event = redact({ path: `/APP/drive/f/${FOLDER}`, campaign: ADDRESS });
        expect(event.path).toBe('/app/drive/f/:folderId');
        expect(event.campaign).toBeUndefined();
    });

    test('a download path that reached the server is logged without its name', () => {
        const event = redact({ path: `/hushos-download/${FOLDER}/tax-return-2026.pdf` });
        expect(event.path).toBe('/hushos-download/:download');
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
            path: '/api/auth/identity/upgrade',
            auth: { action: 'identity/upgrade', outcome: 'rejected' },
        });
        expect(event.path).toBe('/api/auth/identity/upgrade');
        expect(event.auth).toEqual({ action: 'identity/upgrade', outcome: 'rejected' });
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

describe('a failure on a private page', () => {
    test('keeps its class and code, and nothing it said', () => {
        const event = redact({
            path: '/app/drive',
            status: 500,
            failure: { name: 'TypeError', code: 'ERR_X', message: 'maya@example.com' },
        });
        expect(event.failure).toEqual({ kind: 'TypeError', code: 'ERR_X' });
        expect(JSON.stringify(event)).not.toContain('maya@example.com');
    });
});

describe('group routes', () => {
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const PERSON = '00000002-abcd-4abc-8abc-abcdefabcdef';

    test('a group path is logged as its pattern: no group, account or area id survives', () => {
        const event = redact({
            path: `/api/groups/${GROUP}/members/${PERSON}/admit`,
            method: 'POST',
            group: { action: 'groups/:id/members/:userId/admit', outcome: 'success' },
        });
        expect(event.path).toBe('/api/groups/:id/members/:userId/admit');
        expect(event.group).toEqual({
            action: 'groups/:id/members/:userId/admit',
            outcome: 'success',
        });
        expect(JSON.stringify(event)).not.toContain(GROUP);
        expect(JSON.stringify(event)).not.toContain(PERSON);
    });

    test('anything a handler attaches beyond the allowlist is dropped, and an unknown action is not echoed', () => {
        const event = redact({
            path: `/api/groups/${GROUP}/rosters`,
            group: { action: `groups/${GROUP}/rosters`, outcome: 'stale', members: [PERSON] },
            stale: { roster: { signerUserId: PERSON } },
            body: { email: ADDRESS },
        });
        expect(event.group).toEqual({ action: 'unknown', outcome: 'unknown' });
        expect(event.stale).toBeUndefined();
        expect(event.body).toBeUndefined();
        expect(JSON.stringify(event)).not.toContain(PERSON);
        expect(JSON.stringify(event)).not.toContain(ADDRESS);
    });

    test('an invitation path and a group path nobody listed', () => {
        expect(redact({ path: '/api/invitations/accept' }).path).toBe('/api/invitations/accept');
        expect(redact({ path: `/api/groups/${GROUP}/${ADDRESS}` }).path).toBe('/api/unknown');
    });
});
