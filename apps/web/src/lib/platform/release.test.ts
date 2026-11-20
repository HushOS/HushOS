import { afterEach, describe, expect, test, vi } from 'vitest';

/*
 * A tab must notice a deploy from the release the readiness endpoint reports,
 * and reload only when nothing would be lost: the flag is the promise, the
 * reload the act.
 */
describe('release', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });
    const fresh = () => import('./release');
    const ready = (release: string) =>
        vi.fn(async () => ({ headers: new Headers({ 'x-hushos-release': release }) }));

    test('the same release changes nothing; a different one marks the page stale', async () => {
        const release = await fresh();
        release.setServedRelease('a'.repeat(40));
        release.setServedRelease('c'.repeat(40)); // the page cannot change what rendered it
        release.noteRelease('a'.repeat(40));
        expect(release.releaseStale()).toBe(false);
        release.noteRelease('b'.repeat(40));
        expect(release.releaseStale()).toBe(true);
    });

    test('a page without a release of its own never reloads itself for nothing', async () => {
        const fetch = ready('b'.repeat(40));
        vi.stubGlobal('window', { location: { reload: vi.fn() } });
        vi.stubGlobal('fetch', fetch);
        const release = await fresh();
        await release.checkRelease();
        expect(fetch).not.toHaveBeenCalled();
        release.noteRelease('b'.repeat(40));
        expect(release.releaseStale()).toBe(false);
    });

    test('the check asks the readiness endpoint and reloads only when stale and idle', async () => {
        const reload = vi.fn();
        const fetch = ready('b'.repeat(40));
        vi.stubGlobal('window', { location: { reload } });
        vi.stubGlobal('fetch', fetch);
        const release = await fresh();
        release.setServedRelease('a'.repeat(40));
        expect(release.reloadIfStale(false)).toBe(false);
        await release.checkRelease();
        expect(fetch).toHaveBeenCalledWith('/api/ready', { method: 'HEAD', cache: 'no-store' });
        expect(release.releaseStale()).toBe(true);
        expect(release.reloadIfStale(true)).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(release.reloadIfStale(false)).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        // Once stale there is nothing more to ask.
        await release.checkRelease();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('a public page reloads itself only if this tab never opened the app', async () => {
        const { mayReloadPublicPage } = await fresh();
        expect(mayReloadPublicPage({ pathname: '/pricing', moved: true, visitedApp: false })).toBe(
            true,
        );
        // The tab went through /app: an open vault or an upload would be lost.
        expect(mayReloadPublicPage({ pathname: '/pricing', moved: true, visitedApp: true })).toBe(
            false,
        );
        expect(
            mayReloadPublicPage({ pathname: '/app/drive', moved: true, visitedApp: false }),
        ).toBe(false);
        // A form waits for the next navigation so what was typed survives.
        expect(mayReloadPublicPage({ pathname: '/login', moved: false, visitedApp: false })).toBe(
            false,
        );
        expect(mayReloadPublicPage({ pathname: '/login', moved: true, visitedApp: false })).toBe(
            true,
        );
    });
});
