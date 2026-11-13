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
 * WEBAUTHN_ANDROID_ORIGINS lists the Android app origins a passkey or security key may answer
 * from, beside APP_ORIGIN (docs/two-step-design.md 6, 8): `android:apk-key-hash:` and the
 * SHA-256 of the app's signing certificate in Base64url, comma-separated. An Android app's
 * WebAuthn response names that as its origin, not the site's. Unset, the origins are worked
 * out from ANDROID_APP_CERT_SHA256 (`androidOrigins`), the certificates this server already
 * vouches for in its `assetlinks.json`, so a server that serves that file needs nothing more.
 * Set, it is the whole list; `none` takes no Android app's answer at all.
 *
 * Each key can come from a file instead (TWO_STEP_KEY_FILE, TWO_STEP_PREVIOUS_KEY_FILE): a
 * Docker or Kubernetes secret mounted into the container, so the key is in no environment
 * listing. The web service and the worker both read this module, so both take the same forms.
 */
const key = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected 32 bytes, Base64url without padding.')
    .optional();

/*
 * The Android origins, as a list. Each must be exactly an `android:apk-key-hash:` origin: a
 * web origin here would let a page on another site answer for this one, so anything else
 * fails the environment check rather than being accepted or skipped.
 */
export const ANDROID_ORIGIN = /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/;
const listedOrigins = z
    .string()
    .default('')
    .transform((value) =>
        value.trim() === 'none'
            ? ('none' as const)
            : value
                  .split(',')
                  .map((origin) => origin.trim())
                  .filter(Boolean),
    )
    .refine(
        (origins) =>
            origins === 'none' ||
            (origins.length <= 8 && origins.every((origin) => ANDROID_ORIGIN.test(origin))),
        {
            message:
                'Expected up to 8 comma-separated android:apk-key-hash:<43 Base64url characters> origins, or none.',
        },
    );

/*
 * The origin an Android app signed with a certificate answers from: `android:apk-key-hash:` and
 * the certificate's SHA-256, the raw 32 bytes, in Base64url without padding. `fingerprint` is
 * the same digest as `keytool` and the Play Console print it: 32 hex pairs, colon-separated.
 * Null for anything else.
 */
export function androidOriginOf(fingerprint: string) {
    const hex = fingerprint.trim();
    if (!/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/.test(hex)) return null;
    return `android:apk-key-hash:${Buffer.from(hex.replaceAll(':', ''), 'hex').toString('base64url')}`;
}

/*
 * The Android origins this server takes a key's answer from. `listed` is
 * WEBAUTHN_ANDROID_ORIGINS as read: when it names any, it is the whole list, and `none` is
 * none. Otherwise each fingerprint in ANDROID_APP_CERT_SHA256 gives one: those are the
 * certificates `/.well-known/assetlinks.json` already names with `get_login_creds`, which is
 * what lets Android hand the app this site's keys in the first place. So the app the server
 * vouches for is never one whose answers it refuses for want of a second setting.
 */
export function androidOrigins(
    listed: readonly string[] | 'none',
    fingerprints: string | undefined,
) {
    if (listed === 'none') return [];
    if (listed.length > 0) return [...listed];
    return [
        ...new Set(
            (fingerprints ?? '')
                .split(',')
                .map(androidOriginOf)
                .filter((origin): origin is string => origin !== null),
        ),
    ];
}

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
        WEBAUTHN_ANDROID_ORIGINS: listedOrigins,
    },
    runtimeEnv: {
        TWO_STEP_ENABLED: process.env.TWO_STEP_ENABLED,
        WEBAUTHN_ANDROID_ORIGINS: process.env.WEBAUTHN_ANDROID_ORIGINS,
        TWO_STEP_KEY: twoStepKeyFrom(process.env, 'TWO_STEP_KEY'),
        TWO_STEP_PREVIOUS_KEY: twoStepKeyFrom(process.env, 'TWO_STEP_PREVIOUS_KEY'),
    },
    emptyStringAsUndefined: true,
});
