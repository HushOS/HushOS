import { authLogAction } from '@hushos/logging';
import { expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';

/*
 * The log names an auth request by an allowlist kept in the logging package, away
 * from the routes. A route added here and not there is logged as "unknown", and
 * whoever runs the server cannot tell which endpoint is failing.
 */
test('every auth route is logged under its own name', () => {
    const paths = [...new Set(Array.from(source.matchAll(/'(\/auth\/[^']+)'/g), (m) => m[1]!))];
    // Fewer than this and the pattern no longer matches how routes are written.
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((path) => authLogAction(`/api${path}`) === 'unknown')).toEqual([]);
});
