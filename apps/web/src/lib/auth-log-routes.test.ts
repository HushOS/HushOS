// @vitest-environment node
import { authLogAction } from '@hushos/logging';
import { expect, test } from 'vitest';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * The log names an auth request by an allowlist kept in the logging package, away
 * from the routes, and the same allowlist decides which /api/auth paths are served
 * at all: one it doesn't know answers 404 before its body is read. A route added
 * here and not there would be logged as "unknown" and refused.
 */
test('every auth route is logged under its own name, and served', async () => {
    const routes = (await loadApi()).routes as unknown as ApiRoute[];
    const paths = [...new Set(routes.map((r) => r.path).filter((p) => p.startsWith('/api/auth/')))];
    expect(paths.length).toBeGreaterThan(20);
    // As requests arrive: each parameter filled in.
    const uuid = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
    const real = paths.map((path) => path.replace(/:[^/]+/g, uuid));
    expect(real.filter((path) => authLogAction(path) === 'unknown')).toEqual([]);
});
