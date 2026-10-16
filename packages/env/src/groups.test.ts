import { afterEach, describe, expect, test, vi } from 'vitest';

/*
 * The group settings are read once, at startup: a value outside its bounds
 * stops the server there, with the setting's own message, rather than serving
 * with a limit nothing downstream was sized for.
 */

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

/* The groups settings as a server starting with GROUP_AREA_LIMIT=`value` reads them. */
async function startWith(value: string) {
    vi.resetModules();
    vi.stubEnv('GROUP_AREA_LIMIT', value);
    return import('./groups');
}

describe('GROUP_AREA_LIMIT', () => {
    test('50 areas start, and are what the groups read', async () => {
        const { groupsEnv } = await startWith('50');
        expect(groupsEnv.GROUP_AREA_LIMIT).toBe(50);
    });

    test('51 areas refuse to start, saying why', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(startWith('51')).rejects.toThrow('Invalid environment variables');
        const issues = JSON.stringify(logged.mock.calls);
        expect(issues).toContain('GROUP_AREA_LIMIT must be between 1 and 50');
    });
});
