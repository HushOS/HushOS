import { afterEach, expect, test, vi } from 'vitest';

/*
 * Clients offer families only when /drive/capabilities says the server serves
 * groups. The answer must follow GROUPS_ENABLED both ways: a server with the
 * switch off that said `true` would send clients to routes that answer 501,
 * and one with it on that said `false` would hide families that work. The
 * switch is read when the environment loads, so each case loads the domain
 * afresh under its own value.
 */

vi.mock('./storage', () => ({ objectKey: () => '', primaryStore: () => ({}) }));

const original = process.env.GROUPS_ENABLED;
afterEach(() => {
    if (original === undefined) delete process.env.GROUPS_ENABLED;
    else process.env.GROUPS_ENABLED = original;
    vi.resetModules();
});

async function capabilitiesWith(value: string | undefined) {
    if (value === undefined) delete process.env.GROUPS_ENABLED;
    else process.env.GROUPS_ENABLED = value;
    vi.resetModules();
    return (await import('./server')).capabilities();
}

test('capabilities report groups exactly when GROUPS_ENABLED is true, and off by default', async () => {
    expect((await capabilitiesWith('true')).groups).toBe(true);
    expect((await capabilitiesWith('false')).groups).toBe(false);
    expect((await capabilitiesWith(undefined)).groups).toBe(false);
});
