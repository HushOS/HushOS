import { expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';

/*
 * Affiliates are the operator's: their handles, terms, linked accounts and
 * earnings. Every route under /billing/affiliates, the live handle check
 * included, must refuse anyone but an admin before it reads or changes
 * anything, as auth.requireAdmin does (a member gets the 404 of a missing page).
 */
test('every affiliate route asks for an admin before it touches an affiliate', () => {
    const starts = Array.from(
        source.matchAll(/\n {4}\.(get|post|patch|put|delete)\(/g),
        (m) => m.index,
    );
    const routes = starts
        .map((start, index) => source.slice(start, starts[index + 1] ?? source.length))
        .filter((route) => /^\s*\.\w+\(\s*'\/billing\/affiliates/.test(route));
    const paths = routes.map((route) => /'(\/billing\/affiliates[^']*)'/.exec(route)![1]);
    // Fewer than this and the pattern no longer matches how routes are written.
    expect(paths).toEqual(
        expect.arrayContaining(['/billing/affiliates', '/billing/affiliates/handle']),
    );
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const route of routes) {
        const gate = route.indexOf('await auth.requireAdmin(sessionToken)');
        const work = route.search(/\bgrowth\.\w+\(/);
        expect({ route: route.slice(0, 60), gated: gate >= 0 && gate < work }).toEqual({
            route: route.slice(0, 60),
            gated: true,
        });
    }
});
