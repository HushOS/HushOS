import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    rememberReturn,
    returnTarget,
    safeReturnPath,
    signInReturn,
    takeReturn,
} from './return-to';

/* The return address must stay on this site, and a link's key must go no further than this browser. */
describe('return-to', () => {
    afterEach(() => vi.unstubAllGlobals());
    function storage() {
        const map = new Map<string, string>();
        vi.stubGlobal('window', {
            localStorage: {
                getItem: (k: string) => map.get(k) ?? null,
                setItem: (k: string, v: string) => void map.set(k, v),
                removeItem: (k: string) => void map.delete(k),
            },
        });
        return map;
    }

    test('only same-site paths pass; every way off-site is refused', () => {
        expect(safeReturnPath('/app/drive/f/abc?view=grid')).toBe('/app/drive/f/abc?view=grid');
        expect(safeReturnPath('/pricing#plans')).toBe('/pricing');
        for (const bad of [
            'https://evil.example/app',
            '//evil.example/app',
            '/\\evil.example',
            '\\\\evil.example',
            'javascript:alert(1)',
            '/app\n/drive',
            'app/drive',
            '',
            42,
            null,
        ])
            expect(safeReturnPath(bad), String(bad)).toBeNull();
    });

    test('pages that would loop, or are the default, are not returns', () => {
        for (const loop of [
            '/login',
            '/login?x=1',
            '/register/complete',
            '/recover',
            '/setup/recovery-key',
            '/app',
            '/app/drive',
        ])
            expect(safeReturnPath(loop), loop).toBeNull();
        expect(safeReturnPath('/app/contacts')).toBe('/app/contacts');
    });

    test('a saved link keeps its fragment, is used once, and lapses after an hour', () => {
        storage();
        rememberReturn('/s/abc#secret', 1_000);
        expect(takeReturn(2_000)).toBe('/s/abc#secret');
        expect(takeReturn(2_000)).toBeNull();
        rememberReturn('/s/abc#secret', 1_000);
        expect(takeReturn(1_000 + 60 * 60 * 1000 + 1)).toBeNull();
    });

    test('the saved return wins over the query parameter, which wins over Home', () => {
        storage();
        expect(returnTarget(null)).toBe('/app');
        expect(returnTarget('/app/contacts')).toBe('/app/contacts');
        expect(returnTarget('https://evil.example')).toBe('/app');
        rememberReturn('/s/abc#secret');
        expect(returnTarget('/app/contacts')).toBe('/s/abc#secret');
    });

    test('Sign in from a public page goes to the app; only listed pages come back', () => {
        const toApp = { redirect: undefined, remember: false };
        for (const page of ['/', '/blog', '/blog/a-post', '/security', '/terms'])
            expect(signInReturn(page), page).toEqual(toApp);
        // A prefix is a whole segment: these are not under /go, /s, /join or /pricing.
        for (const page of ['/gone', '/support', '/joiners', '/pricingx'])
            expect(signInReturn(page), page).toEqual(toApp);
        expect(signInReturn('/go/creator', '?x=1')).toEqual({
            redirect: '/go/creator?x=1',
            remember: false,
        });
        expect(signInReturn('/app/contacts')).toEqual({
            redirect: '/app/contacts',
            remember: false,
        });
    });

    test('a buyer who signs in on pricing comes back to it, query and all', () => {
        expect(signInReturn('/pricing')).toEqual({ redirect: '/pricing', remember: false });
        expect(signInReturn('/pricing', '?interval=year')).toEqual({
            redirect: '/pricing?interval=year',
            remember: false,
        });
    });

    test('an invite link is left out on purpose: signed in, it is a dead end', () => {
        expect(signInReturn('/r/abc')).toEqual({ redirect: undefined, remember: false });
    });

    test('an address that is not a same-site path gives no redirect', () => {
        // The router matches the first two as an offer page, but put raw in ?redirect= they leave the site.
        for (const page of ['//go/x', '/go/x\\y', 'javascript:alert(1)'])
            expect(signInReturn(page).redirect, page).toBeUndefined();
    });

    test('a shared link or an invitation is remembered, never put in the query string', () => {
        const remembered = { remember: true };
        // However the router would still match a shared link, it is one.
        for (const page of ['/s/abc', '/S/abc', '/%73/abc', '//s/abc', '/join'])
            expect(signInReturn(page, '?p=1'), page).toEqual(remembered);
        expect(signInReturn('/%E0%A4%A')).toEqual({ remember: false });
    });
});
