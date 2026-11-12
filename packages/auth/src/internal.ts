import { createHash, randomBytes } from 'node:crypto';
import { authRepository } from '@hushos/db';
import { authEnv } from '@hushos/env/auth';
import { ready, server } from '@hushos/crypto/server';
import { ENVELOPE_VERSION } from '@hushos/crypto';
import { AuthError } from './tokens';

/*
 * What the auth domain's modules share and nothing outside the package imports: the token
 * helpers, the OPAQUE server setup, and how a notice writes the time.
 */

/*
 * The OPAQUE server setup: from the environment when the operator provides one,
 * otherwise made once on first start and kept in the database under the setup
 * id, so a fresh stack registers accounts without anyone minting a secret by
 * hand. Every password depends on it; the database backup is what keeps it.
 */
let setup: Promise<string> | undefined;
export function serverSetup() {
    setup ??= (async () => {
        if (authEnv.OPAQUE_SERVER_SETUP) return authEnv.OPAQUE_SERVER_SETUP;
        // Beside the password records, a dump of the database is all an offline guess needs.
        if (process.env.NODE_ENV === 'production')
            console.warn(
                'OPAQUE_SERVER_SETUP is not set, so the server setup lives in the database beside the password records. Move it to the environment (see docs/self-hosting.md).',
            );
        await ready;
        return authRepository.ensureServerSecret(
            `opaque-setup:${authEnv.OPAQUE_SERVER_SETUP_ID}`,
            () => server.createSetup(),
        );
    })().catch((error: unknown) => {
        setup = undefined;
        throw error;
    });
    return setup;
}

export function hash(value: string) {
    return createHash('sha256').update(value).digest();
}

export function randomToken() {
    return randomBytes(32).toString('base64url');
}

const noticeTime = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
});
/* When something happened, as every notice to an account's email says it. */
export const noticeWhen = (at: Date = new Date()) => `${noticeTime.format(at)} UTC`;

/* The one account-key envelope version this server writes and reads. */
export function supportedEnvelope(version: number): typeof ENVELOPE_VERSION {
    if (version !== ENVELOPE_VERSION)
        throw new AuthError('This account-key envelope is not supported.', 503);
    return ENVELOPE_VERSION;
}
