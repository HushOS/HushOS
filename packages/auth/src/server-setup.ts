import { authRepository } from '@hushos/db';
import { authEnv } from '@hushos/env/auth';
import { ready, server } from '@hushos/crypto/server';

/*
 * The OPAQUE server setup: from the environment when the operator provides one,
 * otherwise made once on first start and kept in the database under the setup
 * id, so a fresh stack registers accounts without anyone minting a secret by
 * hand. Every password depends on it; the database backup is what keeps it.
 * The two-step key is derived from it too, unless the operator sets one
 * (two-step.ts).
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
