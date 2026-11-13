import { readFileSync } from 'node:fs';
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
 *
 * Each key can come from a file instead (TWO_STEP_KEY_FILE, TWO_STEP_PREVIOUS_KEY_FILE): a
 * Docker or Kubernetes secret mounted into the container, so the key is in no environment
 * listing. The web service and the worker both read this module, so both take the same forms.
 */
const key = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected 32 bytes, Base64url without padding.')
    .optional();

type KeyName = 'TWO_STEP_KEY' | 'TWO_STEP_PREVIOUS_KEY';

/*
 * The key `name` names, from the variable or from the file its `_FILE` form points at. Both
 * set is refused: one of them would be ignored, and which one is a guess the operator should
 * not have to make about the key their people's second step depends on. A file that cannot be
 * read, or is empty, is refused too, rather than read as "no key": the server would then seal
 * under the derived key while its operator believes it uses the one in the file. What a file
 * holds is never put in an error: only the variable's name and why the read failed.
 */
export function twoStepKeyFrom(source: Record<string, string | undefined>, name: KeyName) {
    const value = source[name] || undefined;
    const path = source[`${name}_FILE`] || undefined;
    if (value && path) throw new Error(`Set ${name} or ${name}_FILE, not both.`);
    if (!path) return value;
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown error';
        throw new Error(`${name}_FILE could not be read (${code}).`);
    }
    // A secret file usually ends with a newline; nothing else is forgiven.
    const trimmed = text.replace(/^\s+|\s+$/g, '');
    if (!trimmed) throw new Error(`${name}_FILE is empty.`);
    return trimmed;
}

export const twoStepEnv = createEnv({
    server: {
        TWO_STEP_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        TWO_STEP_KEY: key,
        TWO_STEP_PREVIOUS_KEY: key,
    },
    runtimeEnv: {
        TWO_STEP_ENABLED: process.env.TWO_STEP_ENABLED,
        TWO_STEP_KEY: twoStepKeyFrom(process.env, 'TWO_STEP_KEY'),
        TWO_STEP_PREVIOUS_KEY: twoStepKeyFrom(process.env, 'TWO_STEP_PREVIOUS_KEY'),
    },
    emptyStringAsUndefined: true,
});
