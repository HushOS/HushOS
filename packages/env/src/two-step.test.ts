import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

/*
 * The two-step keys are read once, at startup, from the environment or from a file
 * (docs/two-step-design.md 8). What is read here is the key every authenticator secret is
 * sealed under: reading the wrong one, or none where the operator named one, either locks
 * people out of their second step or seals it under a key the operator never chose.
 */

// Fixed values, so a failure reproduces: 32 bytes each, Base64url without padding.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const OTHER = '_-7d3Nva2djX1tXU09LR0M_OzczLysrJyMfGxcTDwsE';

const folder = mkdtempSync(join(tmpdir(), 'hushos-two-step-env-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function file(name: string, content: string) {
    const path = join(folder, name);
    writeFileSync(path, content);
    return path;
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

/* The two-step settings as a server starting with `env` reads them. */
async function startWith(env: Record<string, string>) {
    vi.resetModules();
    for (const name of [
        'TWO_STEP_KEY',
        'TWO_STEP_KEY_FILE',
        'TWO_STEP_PREVIOUS_KEY',
        'TWO_STEP_PREVIOUS_KEY_FILE',
        'WEBAUTHN_ANDROID_ORIGINS',
    ])
        vi.stubEnv(name, env[name] ?? '');
    return (await import('./two-step')).twoStepEnv;
}

describe('TWO_STEP_KEY_FILE and TWO_STEP_PREVIOUS_KEY_FILE', () => {
    test('each key is read from its own file, as the variable would have given it', async () => {
        const env = await startWith({
            TWO_STEP_KEY_FILE: file('current', KEY),
            TWO_STEP_PREVIOUS_KEY_FILE: file('previous', OTHER),
        });
        expect(env.TWO_STEP_KEY).toBe(KEY);
        expect(env.TWO_STEP_PREVIOUS_KEY).toBe(OTHER);
        // And the same two values from the variables are the same two keys.
        const plain = await startWith({ TWO_STEP_KEY: KEY, TWO_STEP_PREVIOUS_KEY: OTHER });
        expect([plain.TWO_STEP_KEY, plain.TWO_STEP_PREVIOUS_KEY]).toEqual([KEY, OTHER]);
    });

    test('a file and a variable can be mixed, one key each', async () => {
        const env = await startWith({
            TWO_STEP_KEY_FILE: file('mixed', KEY),
            TWO_STEP_PREVIOUS_KEY: OTHER,
        });
        expect([env.TWO_STEP_KEY, env.TWO_STEP_PREVIOUS_KEY]).toEqual([KEY, OTHER]);
    });

    test('the newline a secret file ends with is not part of the key', async () => {
        for (const content of [`${KEY}\n`, `${KEY}\r\n`, `\n${KEY}\n\n`])
            expect(
                (await startWith({ TWO_STEP_KEY_FILE: file('newline', content) })).TWO_STEP_KEY,
            ).toBe(KEY);
    });

    test.each(['TWO_STEP_KEY', 'TWO_STEP_PREVIOUS_KEY'] as const)(
        '%s set both ways refuses to start, even when the two agree',
        async (name) => {
            for (const inFile of [OTHER, KEY])
                await expect(
                    startWith({ [name]: KEY, [`${name}_FILE`]: file('both', inFile) }),
                ).rejects.toThrow(`Set ${name} or ${name}_FILE, not both.`);
        },
    );

    test('a file that is missing or unreadable refuses to start; it is never read as "no key"', async () => {
        await expect(startWith({ TWO_STEP_KEY_FILE: join(folder, 'not-there') })).rejects.toThrow(
            'TWO_STEP_KEY_FILE could not be read (ENOENT).',
        );
        // A directory where the file should be: a secret mounted at the wrong path.
        await expect(startWith({ TWO_STEP_PREVIOUS_KEY_FILE: folder })).rejects.toThrow(
            'TWO_STEP_PREVIOUS_KEY_FILE could not be read (EISDIR).',
        );
        // Root reads any file, so the permission case is only checked for an ordinary user.
        if (process.getuid?.() !== 0) {
            const locked = file('locked', KEY);
            chmodSync(locked, 0o000);
            await expect(startWith({ TWO_STEP_KEY_FILE: locked })).rejects.toThrow(
                'TWO_STEP_KEY_FILE could not be read (EACCES).',
            );
        }
    });

    test('an empty file refuses to start, rather than falling back to the derived key', async () => {
        for (const content of ['', '\n', '  \n'])
            await expect(startWith({ TWO_STEP_KEY_FILE: file('empty', content) })).rejects.toThrow(
                'TWO_STEP_KEY_FILE is empty.',
            );
    });

    test('a file that does not hold a key refuses to start, and what it holds is never printed', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const secret = 'not-a-key-but-still-somebodys-secret';
        // One character short, padded, two keys on two lines, and something else entirely.
        for (const content of [KEY.slice(1), `${KEY}=`, `${KEY}\n${OTHER}`, secret]) {
            const refused = await startWith({ TWO_STEP_KEY_FILE: file('wrong', content) }).then(
                () => null,
                (error: unknown) => error,
            );
            expect(refused).toBeInstanceOf(Error);
            expect((refused as Error).message).toContain('Invalid environment variables');
            expect((refused as Error).message).not.toContain(content.split('\n')[0]);
        }
        expect(JSON.stringify(logged.mock.calls)).toContain(
            'Expected 32 bytes, Base64url without padding.',
        );
        expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(logged.mock.calls)).not.toContain(KEY.slice(1));
    });

    test('with neither form set there is no explicit key, and an empty _FILE is as good as unset', async () => {
        const env = await startWith({});
        expect([env.TWO_STEP_KEY, env.TWO_STEP_PREVIOUS_KEY]).toEqual([undefined, undefined]);
        // Compose passes unset variables as empty strings.
        const set = await startWith({ TWO_STEP_KEY: KEY, TWO_STEP_KEY_FILE: '' });
        expect(set.TWO_STEP_KEY).toBe(KEY);
    });
});

describe('WEBAUTHN_ANDROID_ORIGINS', () => {
    const APP = 'android:apk-key-hash:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const DEBUG = 'android:apk-key-hash:_-7d3Nva2djX1tXU09LR0M_OzczLysrJyMfGxcTDwsE';

    test('unset or empty, no Android origin is accepted; set, each origin is its own entry', async () => {
        expect((await startWith({})).WEBAUTHN_ANDROID_ORIGINS).toEqual([]);
        expect(
            (await startWith({ WEBAUTHN_ANDROID_ORIGINS: ` ${APP} , ${DEBUG},` }))
                .WEBAUTHN_ANDROID_ORIGINS,
        ).toEqual([APP, DEBUG]);
    });

    test('unset, an origin is worked out from each certificate the server vouches for; set, it is the whole list', async () => {
        const { androidOriginOf, androidOrigins } = await import('./two-step');
        // SHA-256 of the empty string, as keytool prints a fingerprint, and the same 32 bytes
        // in Base64url without padding: a pair known apart from this code.
        const fingerprint =
            'E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55';
        const origin = 'android:apk-key-hash:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
        expect(androidOriginOf(fingerprint)).toBe(origin);
        expect(androidOriginOf(fingerprint.toLowerCase())).toBe(origin);
        // Hex of the digest's text, or Base64 with its padding and its + and /, would not be it.
        expect(origin).not.toContain('=');
        expect(androidOriginOf('E3:B0')).toBeNull();
        expect(androidOriginOf('not a fingerprint')).toBeNull();

        // Two certificates (Play's and the upload key), as ANDROID_APP_CERT_SHA256 lists them.
        const upload = Array.from({ length: 32 }, () => 'AB').join(':');
        const derived = androidOrigins([], `${fingerprint}, ${upload}`);
        expect(derived).toEqual([origin, androidOriginOf(upload)]);
        expect(androidOrigins([], undefined)).toEqual([]);
        expect(androidOrigins([], `${fingerprint},${fingerprint}`)).toEqual([origin]);
        // Listed, the setting is the whole answer: the certificate's own origin is not added.
        expect(androidOrigins([APP], fingerprint)).toEqual([APP]);
        // And an operator who vouches for an app's links but wants none of its keys can say so.
        expect(androidOrigins('none', fingerprint)).toEqual([]);
        expect(
            (await startWith({ WEBAUTHN_ANDROID_ORIGINS: ' none ' })).WEBAUTHN_ANDROID_ORIGINS,
        ).toBe('none');
    });

    test('anything that is not an app’s key-hash origin refuses to start: a web origin here would answer for this site', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const value of [
            'https://evil.example',
            `${APP},https://hushos.com`,
            'android:apk-key-hash:short',
            `${APP}=`,
            '*',
        ])
            await expect(startWith({ WEBAUTHN_ANDROID_ORIGINS: value })).rejects.toThrow(
                'Invalid environment variables',
            );
    });
});
