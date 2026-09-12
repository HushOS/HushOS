import { authEnv } from '@hushos/env/auth';
import {
    AuthError,
    ENROLLMENT_SECONDS,
    SESSION_MAX_SECONDS,
    TOKEN_PATTERN,
    type TokenKind,
} from './tokens';

/*
 * Everything auth knows about HTTP lives here: which cookie carries which token,
 * how to read and write them, the address a rate limit is keyed on, and the checks
 * a browser-originated mutation must pass. The functions in `server.ts` never see
 * a request; they take tokens and plain values and return tokens.
 */

function secure() {
    return authEnv.APP_ORIGIN.startsWith('https:');
}

function cookieName(kind: TokenKind) {
    return `${secure() ? '__Host-' : ''}hushos-${kind}`;
}

/* The token in the named cookie, or null when absent or not shaped like one of ours. */
export function readToken(request: Request, kind: TokenKind) {
    const name = cookieName(kind);
    const value = request.headers
        .get('cookie')
        ?.split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    return value && TOKEN_PATTERN.test(value) ? value : null;
}

export function readSessionToken(request: Request) {
    return readToken(request, 'session');
}

export function readEnrollmentToken(request: Request) {
    return readToken(request, 'enrollment');
}

/* Cookie presence only: enough to draw a signed-in header, never to trust. */
export function hasSessionCookie(request: Request) {
    return readSessionToken(request) !== null;
}

/* A Set-Cookie value that stores the token, or clears the cookie when the token is null. */
export function authCookie(kind: TokenKind, token: string | null) {
    const seconds = token ? (kind === 'session' ? SESSION_MAX_SECONDS : ENROLLMENT_SECONDS) : 0;
    return `${cookieName(kind)}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure() ? '; Secure' : ''}`;
}

/*
 * The address rate limits are keyed on. Behind a reverse proxy, set
 * TRUSTED_PROXY_HEADER so the proxy's header is used; the last value in a
 * comma-separated list is the one the nearest proxy appended. Without it the
 * socket address is used, which behind a proxy is the proxy itself.
 */
export function clientAddress(request: Request, remoteAddress?: string) {
    const header = authEnv.TRUSTED_PROXY_HEADER;
    if (header) {
        const value = request.headers.get(header);
        const last = value?.split(',').at(-1)?.trim();
        if (last && last.length <= 64) return last;
    }
    return remoteAddress?.trim() || 'unknown';
}

/* A state-changing auth request must come from our own pages, as JSON. */
export function guardAuthMutation(request: Request) {
    if (request.headers.get('origin') !== authEnv.APP_ORIGIN)
        throw new AuthError('This request must come from HushOS.', 403);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new AuthError('Expected a JSON request.', 400);
}
