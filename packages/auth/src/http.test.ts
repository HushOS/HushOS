import { describe, expect, test } from 'vitest';

/*
 * The HTTP edge of auth: which cookie a token is read from, what shape it must
 * have, and which requests may change state. Nothing here touches the database.
 */
process.env.APP_ORIGIN = 'https://hush.example';
process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(120);
process.env.TRUSTED_PROXY_HEADER = 'x-forwarded-for';

const http = await import('./http');
const { AuthError } = await import('./tokens');

const TOKEN = 'k'.repeat(43);
const OTHER = 'm'.repeat(43);

function request(headers: Record<string, string>) {
    return new Request('https://hush.example/api/auth/session', { headers });
}

describe('cookies', () => {
    test('reads the session and enrollment tokens from their own cookies', () => {
        const req = request({
            cookie: `theme=dark; __Host-hushos-session=${TOKEN}; __Host-hushos-enrollment=${OTHER}`,
        });
        expect(http.readSessionToken(req)).toBe(TOKEN);
        expect(http.readEnrollmentToken(req)).toBe(OTHER);
        expect(http.hasSessionCookie(req)).toBe(true);
    });

    test('a token that is not ours in shape is treated as absent', () => {
        for (const value of ['', 'k'.repeat(42), 'k'.repeat(44), `${'k'.repeat(42)}=`, 'k k'])
            expect(
                http.readSessionToken(request({ cookie: `__Host-hushos-session=${value}` })),
            ).toBe(null);
        expect(http.hasSessionCookie(request({}))).toBe(false);
    });

    test('an unprefixed cookie is ignored on an HTTPS origin', () => {
        // Only a `__Host-` cookie is guaranteed to have been set by this origin over TLS.
        expect(http.readSessionToken(request({ cookie: `hushos-session=${TOKEN}` }))).toBe(null);
    });

    test('a stored cookie is host-locked, HTTP-only, and expires; a cleared one expires now', () => {
        const stored = http.authCookie('session', TOKEN);
        expect(stored).toContain(`__Host-hushos-session=${TOKEN}`);
        expect(stored).toContain('HttpOnly');
        expect(stored).toContain('Secure');
        expect(stored).toContain('SameSite=Lax');
        expect(stored).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
        expect(http.authCookie('enrollment', TOKEN)).toContain(`Max-Age=${30 * 60}`);
        expect(http.authCookie('session', null)).toContain('__Host-hushos-session=; ');
        expect(http.authCookie('session', null)).toContain('Max-Age=0');
    });

    test('a written cookie reads back through the same rules', () => {
        const [pair] = http.authCookie('enrollment', TOKEN).split(';');
        expect(http.readEnrollmentToken(request({ cookie: pair! }))).toBe(TOKEN);
    });
});

describe('client address', () => {
    test('takes the value the nearest proxy appended, never one the client sent first', () => {
        const req = request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' });
        expect(http.clientAddress(req, '10.0.0.2')).toBe('203.0.113.9');
    });

    test('falls back to the socket when the header is missing, empty, or oversized', () => {
        expect(http.clientAddress(request({}), '10.0.0.2')).toBe('10.0.0.2');
        expect(http.clientAddress(request({ 'x-forwarded-for': ' ' }), '10.0.0.2')).toBe(
            '10.0.0.2',
        );
        expect(http.clientAddress(request({ 'x-forwarded-for': 'a'.repeat(65) }), '10.0.0.2')).toBe(
            '10.0.0.2',
        );
        expect(http.clientAddress(request({}))).toBe('unknown');
    });
});

describe('mutation guard', () => {
    test('accepts a JSON request from the app origin', () => {
        expect(() =>
            http.guardAuthMutation(
                request({ origin: 'https://hush.example', 'content-type': 'application/json' }),
            ),
        ).not.toThrow();
        expect(() =>
            http.guardAuthMutation(
                request({
                    origin: 'https://hush.example',
                    'content-type': 'application/json; charset=utf-8',
                }),
            ),
        ).not.toThrow();
    });

    test('refuses another origin, a missing origin, and a form post', () => {
        const foreign = request({
            origin: 'https://evil.example',
            'content-type': 'application/json',
        });
        expect(() => http.guardAuthMutation(foreign)).toThrow(AuthError);
        expect(() => http.guardAuthMutation(foreign)).toThrow(
            expect.objectContaining({ status: 403 }),
        );
        expect(() =>
            http.guardAuthMutation(request({ 'content-type': 'application/json' })),
        ).toThrow(expect.objectContaining({ status: 403 }));
        expect(() =>
            http.guardAuthMutation(
                request({
                    origin: 'https://hush.example',
                    'content-type': 'application/x-www-form-urlencoded',
                }),
            ),
        ).toThrow(expect.objectContaining({ status: 400 }));
    });
});
