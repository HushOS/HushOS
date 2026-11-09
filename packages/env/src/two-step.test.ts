import { afterEach, describe, expect, test, vi } from 'vitest';

/*
 * The two-step settings are read once, at startup. The flag ships off; a key
 * that is not 32 bytes stops the server there, rather than sealing secrets
 * under something shorter than it looks.
 */

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

async function startWith(env: Record<string, string>) {
    vi.resetModules();
    for (const name of ['TWO_STEP_ENABLED', 'TWO_STEP_KEY', 'TWO_STEP_PREVIOUS_KEY'])
        vi.stubEnv(name, env[name] ?? '');
    return (await import('./two-step')).twoStepEnv;
}

const KEY = Buffer.alloc(32, 7).toString('base64url');

describe('TWO_STEP_ENABLED', () => {
    test('is off unless it is set to true', async () => {
        expect((await startWith({})).TWO_STEP_ENABLED).toBe(false);
        expect((await startWith({ TWO_STEP_ENABLED: 'false' })).TWO_STEP_ENABLED).toBe(false);
        expect((await startWith({ TWO_STEP_ENABLED: 'true' })).TWO_STEP_ENABLED).toBe(true);
    });

    test('refuses a value that is neither, rather than guess', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(startWith({ TWO_STEP_ENABLED: 'yes' })).rejects.toThrow(
            'Invalid environment variables',
        );
    });
});

describe('TWO_STEP_KEY and TWO_STEP_PREVIOUS_KEY', () => {
    test('are optional, and taken as 32 bytes of base64url', async () => {
        const unset = await startWith({});
        expect(unset.TWO_STEP_KEY).toBeUndefined();
        expect(unset.TWO_STEP_PREVIOUS_KEY).toBeUndefined();
        const set = await startWith({ TWO_STEP_KEY: KEY, TWO_STEP_PREVIOUS_KEY: KEY });
        expect(Buffer.from(set.TWO_STEP_KEY!, 'base64url')).toHaveLength(32);
        expect(set.TWO_STEP_PREVIOUS_KEY).toBe(KEY);
    });

    test('a key of another length, or padded, refuses to start', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const bad of [KEY.slice(1), `${KEY}A`, `${KEY.slice(0, -1)}=`, 'hunter2'])
            await expect(startWith({ TWO_STEP_KEY: bad }), bad).rejects.toThrow(
                'Invalid environment variables',
            );
        expect(JSON.stringify(logged.mock.calls)).toContain('TWO_STEP_KEY');
    });
});
