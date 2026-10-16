/*
 * Shared between the domain (`server.ts`) and the HTTP edge (`http.ts`): what a
 * token looks like, how long each kind lives, and how auth reports a failure.
 */

// Sessions slide: seven days from the last request, never more than thirty from sign-in.
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;
export const ENROLLMENT_SECONDS = 30 * 60;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type TokenKind = 'session' | 'enrollment';

/*
 * A refusal a client may act on by its code rather than its words: `current`
 * (the device asking is the one named; sign out instead), `registered` (the
 * device already described itself). Approval will add `busy` and `policy`.
 */
export type AuthErrorCode = 'current' | 'registered' | 'key-in-use';

export class AuthError extends Error {
    readonly code?: AuthErrorCode;
    constructor(
        message: string,
        readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400,
        options?: { cause?: unknown; code?: AuthErrorCode },
    ) {
        super(message, options);
        this.name = 'AuthError';
        this.code = options?.code;
    }
}
