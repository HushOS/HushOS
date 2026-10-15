import { authLogAction } from '@hushos/logging';
import { expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';

/*
 * The log names an auth request by an allowlist kept in the logging package, away
 * from the routes, and the same allowlist decides which /api/auth paths are served
 * at all: one it doesn't know answers 404 before its body is read. A route added
 * here and not there would be logged as "unknown" and refused.
 */
test('every auth route is logged under its own name, and served', () => {
    const paths = [...new Set(Array.from(source.matchAll(/'(\/auth\/[^']+)'/g), (m) => m[1]!))];
    // Fewer than this and the pattern no longer matches how routes are written.
    expect(paths.length).toBeGreaterThan(20);
    // A route written any other way would escape the pattern above.
    expect(source).not.toMatch(/["`]\/auth\//);
    // As requests arrive: each parameter filled in.
    const uuid = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
    const real = paths.map((path) => `/api${path.replace(/:[^/]+/g, uuid)}`);
    expect(real.filter((path) => authLogAction(path) === 'unknown')).toEqual([]);
});
