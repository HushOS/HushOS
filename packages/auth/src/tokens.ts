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

export class AuthError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 401 | 403 | 409 | 429 | 503 = 400,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = 'AuthError';
    }
}
