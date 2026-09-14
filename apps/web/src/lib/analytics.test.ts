import { afterEach, describe, expect, test } from 'vitest';
import { analyticsAllowed, BEFORE_SEND, installAnalyticsFilter } from './analytics';

/*
 * Where the analytics script may go is a privacy promise on the privacy page:
 * the app, every way in, and shared links are never measured.
 */
describe('analytics', () => {
    test('public pages are allowed; the app, sign-in, sign-up, recovery and shared links are not', () => {
        for (const path of [
            '/',
            '/pricing',
            '/blog/hushos-1-0',
            '/vs/proton-drive',
            '/go/x',
            '/r/abc',
            '/privacy',
        ])
            expect(analyticsAllowed(path), path).toBe(true);
        for (const path of [
            '/app',
            '/app/drive/folder',
            '/login',
            '/register/complete',
            '/recover',
            '/s/abcdef',
            '/account-deleted',
            '/api/drive/workspace',
        ])
            expect(analyticsAllowed(path), path).toBe(false);
        // A prefix is a path segment, not a string prefix.
        expect(analyticsAllowed('/apps-we-like')).toBe(true);
        expect(analyticsAllowed('/security')).toBe(true);
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>)[BEFORE_SEND];
    });

    test('a beacon for a private page is dropped before it leaves', () => {
        Object.defineProperty(globalThis, 'window', {
            value: globalThis,
            configurable: true,
            writable: true,
        });
        (globalThis as Record<string, unknown>).location = { origin: 'https://hushos.com' };
        installAnalyticsFilter();
        const filter = (globalThis as Record<string, unknown>)[BEFORE_SEND] as (
            type: string,
            payload: { url?: string },
        ) => unknown;
        expect(filter('event', { url: '/pricing' })).toEqual({ url: '/pricing' });
        expect(filter('event', { url: '/app/drive' })).toBe(false);
        expect(filter('event', { url: 'https://hushos.com/s/token' })).toBe(false);
        expect(filter('event', { url: 'http://[bad' })).toBe(false);
    });
});
