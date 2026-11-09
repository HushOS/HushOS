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
 *
 * Two-step sign-in (docs/two-step-design.md 10):
 * - `update-required`: the account asks for a second step and this client cannot answer one;
 * - `two-step`: the second step is needed and was missing or wrong (401 at sign-in, where the
 *   token takes another answer; 403 at a change);
 * - `two-step-expired`: the step token is gone (five minutes, five wrong answers, a password
 *   change): start again, from the password at sign-in or from a new challenge at a change;
 * - `totp-frozen`: authenticator codes are paused here; another method still answers;
 * - `unsupported`: this server does not offer two-step sign-in (TWO_STEP_ENABLED).
 */
export type AuthErrorCode =
    | 'current'
    | 'registered'
    | 'key-in-use'
    | 'update-required'
    | 'two-step'
    | 'two-step-expired'
    | 'totp-frozen'
    | 'unsupported';

export class AuthError extends Error {
    readonly code?: AuthErrorCode;
    constructor(
        message: string,
        readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 501 | 503 = 400,
        options?: { cause?: unknown; code?: AuthErrorCode },
    ) {
        super(message, options);
        this.name = 'AuthError';
        this.code = options?.code;
    }
}
