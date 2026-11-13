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
 * Two-step sign-in (docs/two-step-design.md 4):
 * - `update-required`: the account asks for a second step and this client cannot answer one;
 * - `two-step`: the action needs the step and came without it, or the step was turned on meanwhile;
 * - `step-wrong`: the answer was wrong, and the token still has answers left;
 * - `step-expired`: the token is over (five wrong answers, five minutes, or used): start again;
 * - `step-frozen`: the authenticator app is paused for this sign-in; use another method;
 * - `step-limited`: too many wrong codes in 15 minutes; the recovery phrase still works;
 * - `step-unavailable`: the server cannot check this method right now (a row under a key it
 *   no longer has); nothing was counted or changed, and the recovery phrase still works;
 * - `setup-required`: the account has no recovery key yet, so the step cannot be turned on:
 *   finish account setup first;
 * - `limit`: the account has as many passkeys and security keys as it may;
 * - `exists`: that passkey or security key is already on the account;
 * - `key-refused`: a key's registration did not verify, and its one answer is used up;
 * - `step-pending`: another device has not approved yet; nothing was looked at or counted;
 * - `device-limited`, `device-busy`, `device-unavailable`: another device cannot be asked
 *   now (the day's requests are spent; another sign-in's request is being answered; no device
 *   could approve);
 * - `device-mismatch`: what the asking device revealed is not what it committed to;
 * - `approval-over`, `approval-taken`, `approval-refused`: a request an approving device
 *   can no longer answer, one another device is answering, and a signature that did not verify.
 */
export type AuthErrorCode =
    | 'current'
    | 'registered'
    | 'key-in-use'
    | 'update-required'
    | 'two-step'
    | 'step-wrong'
    | 'step-expired'
    | 'step-frozen'
    | 'step-limited'
    | 'step-unavailable'
    | 'setup-required'
    | 'limit'
    | 'exists'
    | 'key-refused'
    | 'step-pending'
    | 'device-limited'
    | 'device-busy'
    | 'device-unavailable'
    | 'device-mismatch'
    | 'approval-over'
    | 'approval-taken'
    | 'approval-refused';

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
