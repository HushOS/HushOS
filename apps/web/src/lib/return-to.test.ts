import { afterEach, describe, expect, test, vi } from 'vitest';
import { rememberReturn, returnTarget, safeReturnPath, takeReturn } from './return-to';

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

    test('the saved return wins over the query parameter, which wins over Drive', () => {
        storage();
        expect(returnTarget(null)).toBe('/app/drive');
        expect(returnTarget('/app/contacts')).toBe('/app/contacts');
        expect(returnTarget('https://evil.example')).toBe('/app/drive');
        rememberReturn('/s/abc#secret');
        expect(returnTarget('/app/contacts')).toBe('/s/abc#secret');
    });
});
