import { afterEach, describe, expect, test, vi } from 'vitest';

/*
 * DRIVE_CLIENT_MINIMUMS is read once, at startup. A value written before 1.0.0
 * (protocol numbers, "web/3") must still start the server: refusing it would
 * take an upgraded deployment down over a setting that used to be valid.
 */

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

/* The storage settings as a server starting with DRIVE_CLIENT_MINIMUMS=`value` reads them. */
async function startWith(value: string) {
    vi.resetModules();
    vi.stubEnv('STORAGE_ENDPOINT', 'http://127.0.0.1:3900');
    vi.stubEnv('STORAGE_BUCKET', 'hushos-test');
    vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'test-key');
    vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'test-secret');
    vi.stubEnv('DRIVE_CLIENT_MINIMUMS', value);
    return import('./storage');
}

describe('DRIVE_CLIENT_MINIMUMS', () => {
    test.each(['web/1.0.0,ios/1.0.0', 'web/3', 'web/1', 'web/3,ios/1.0.0,android/2'])(
        '%s starts, and is what the API reads',
        async (value) => {
            const { storageEnv } = await startWith(value);
            expect(storageEnv.DRIVE_CLIENT_MINIMUMS).toBe(value);
        },
    );

    test.each(['web', 'web/1.x', 'Web/1.0.0', 'web/1.0.0;ios/1.0.0'])(
        '%s refuses to start, saying what to write',
        async (value) => {
            const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            await expect(startWith(value)).rejects.toThrow('Invalid environment variables');
            expect(JSON.stringify(logged.mock.calls)).toContain('web/1.0.0,ios/1.0.0');
        },
    );
});
