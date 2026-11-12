import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/*
 * Two-step sign-in (docs/two-step-design.md 8). Off by default while the clients that answer
 * the step are built: with TWO_STEP_ENABLED=false nobody can turn the step on, and the routes
 * that set it up or manage it answer 501. An account that already has the step is still asked
 * for it at sign-in and at security changes, whatever this says: turning the flag off is not
 * a way around anyone's second step.
 *
 * TWO_STEP_KEY seals authenticator secrets and keys the backup-code hash: 32 bytes, Base64url
 * without padding. Unset, the key is derived from the OPAQUE server setup, wherever that lives.
 * TWO_STEP_PREVIOUS_KEY is the key before a rotation of TWO_STEP_KEY, kept while rows sealed or
 * hashed under it remain.
 */
const key = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected 32 bytes, Base64url without padding.')
    .optional();

export const twoStepEnv = createEnv({
    server: {
        TWO_STEP_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        TWO_STEP_KEY: key,
        TWO_STEP_PREVIOUS_KEY: key,
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
