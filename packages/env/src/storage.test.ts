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

/*
 * The two settings that bound what a store may do to the server
 * (docs/company-storage-design.md 2.4). A value that parsed to nothing would
 * not be a looser bound but none: a rate of zero is a deadline that never comes.
 */
describe('the store bounds', () => {
    async function startWithBounds(env: Record<string, string>) {
        vi.resetModules();
        vi.stubEnv('STORAGE_ENDPOINT', 'http://127.0.0.1:3900');
        vi.stubEnv('STORAGE_BUCKET', 'hushos-test');
        vi.stubEnv('STORAGE_ACCESS_KEY_ID', 'test-key');
        vi.stubEnv('STORAGE_SECRET_ACCESS_KEY', 'test-secret');
        for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
        return import('./storage');
    }

    test('default to 256 KiB a second and 60 seconds of a run, with nothing set or set to nothing', async () => {
        const unset: Record<string, string>[] = [
            {},
            { STORAGE_MIN_BYTES_PER_SECOND: '', STORAGE_STORE_RUN_SECONDS: '' },
        ];
        for (const env of unset) {
            const { storageEnv } = await startWithBounds(env);
            expect(storageEnv.STORAGE_MIN_BYTES_PER_SECOND).toBe(262_144);
            expect(storageEnv.STORAGE_STORE_RUN_SECONDS).toBe(60);
        }
    });

    test('are read as numbers, so an operator behind a slow link can lower the rate', async () => {
        const { storageEnv } = await startWithBounds({
            STORAGE_MIN_BYTES_PER_SECOND: '65536',
            STORAGE_STORE_RUN_SECONDS: '300',
        });
        expect(storageEnv.STORAGE_MIN_BYTES_PER_SECOND).toBe(65_536);
        expect(storageEnv.STORAGE_STORE_RUN_SECONDS).toBe(300);
    });

    test.each([
        ['STORAGE_MIN_BYTES_PER_SECOND', '0'],
        ['STORAGE_MIN_BYTES_PER_SECOND', '1023'],
        ['STORAGE_MIN_BYTES_PER_SECOND', '-1'],
        ['STORAGE_MIN_BYTES_PER_SECOND', '256k'],
        ['STORAGE_MIN_BYTES_PER_SECOND', '1073741825'],
        ['STORAGE_STORE_RUN_SECONDS', '0'],
        ['STORAGE_STORE_RUN_SECONDS', '1501'],
        ['STORAGE_STORE_RUN_SECONDS', '1.5'],
    ])('%s=%s refuses to start rather than run without the bound', async (name, value) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(startWithBounds({ [name]: value })).rejects.toThrow(
            'Invalid environment variables',
        );
    });
});
