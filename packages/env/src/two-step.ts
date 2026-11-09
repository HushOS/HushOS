import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/*
 * Two-step sign-in (docs/two-step-design.md 8). Off by default while the apps
 * that can answer the step are built: with TWO_STEP_ENABLED=false nobody can
 * turn the step on and the routes that manage it answer 501. An account that
 * already has a method is still asked for it, at sign-in and at every change
 * the step guards, whatever this says: the flag never takes a step away.
 *
 * TWO_STEP_KEY seals authenticator secrets and keys the backup-code hash.
 * Unset, the key is derived from the OPAQUE server setup, wherever that is
 * kept. TWO_STEP_PREVIOUS_KEY is the key TWO_STEP_KEY replaced: secrets and
 * codes made under it keep working while it is set. Both are 32 random bytes,
 * base64url.
 */
const key = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes, base64url without padding (43 characters)')
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
