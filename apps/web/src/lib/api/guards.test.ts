// @vitest-environment node
import { beforeAll, describe, expect, test } from 'vitest';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * Which checks every API route runs, read from the app's own route table, and what a request
 * with no session gets. A route that loses its guard, or a new one outside every guard, fails
 * here: it isn't on the list of public routes, so it must carry the checks its feature declares.
 */

type Route = ApiRoute;
let routes: Route[] = [];
let handle: (request: Request) => Promise<Response>;

beforeAll(async () => {
    const apiApp = await loadApi();
    routes = apiApp.routes as unknown as Route[];
    handle = (request) => apiApp.handle(request);
});

/*
 * The names of the checks a route runs before its handler, in order: the guards' macros in
 * shared.server.ts, each a named function. Read from Elysia's route table (`~deriveEntries`), so
 * an Elysia upgrade that moves it fails here loudly rather than passing with nothing checked.
 */
const GUARD_CHECKS = [
    'groupsOffered',
    'sameOrigin',
    'namedClient',
    'familyChangeFloor',
    'signedIn',
    'operatorOnly',
];
function checks(route: Route): string[] {
    const entries = route.hooks?.['~deriveEntries'] ?? [];
    expect(Array.isArray(entries), `${route.method} ${route.path}: no derive list`).toBe(true);
    return (entries as Array<{ name?: string }>)
        .map((entry) => entry.name ?? '')
        .filter((name) => GUARD_CHECKS.includes(name));
}

const key = (route: Route) => `${route.method} ${route.path.replace(/^\/api/, '')}`;

/*
 * Reachable with no session, each on purpose, with exactly the guard checks it runs: filing a
 * report is a write, so it carries the Origin check; the rest run none.
 */
const PUBLIC = new Map<string, string[]>([
    ['GET /health', []],
    ['GET /ready', []],
    ['GET /billing/catalogue', []],
    ['GET /drive/capabilities', []],
    ['GET /drive/reports/operators', []],
    ['POST /drive/reports', ['sameOrigin']], // a link holder or a sharer, session or not; filed reports are rate limited
    // The link visitor's surface: the token in x-link-token, rate limited per token and address.
    ['GET /drive/links/open', []],
    ['GET /drive/links/nodes/:nodeId/children', []],
    ['GET /drive/links/versions/:versionId/url', []],
    ['POST /drive/links/versions/urls', []],
    ['GET /drive/links/thumbnails', []],
    // Retired paths that carried the token: 410 so an old client says why.
    ['GET /drive/links/:id/open', []],
    ['GET /drive/links/:id/nodes/:nodeId/children', []],
    ['GET /drive/links/:id/versions/:versionId/url', []],
    ['POST /drive/links/:id/versions/urls', []],
    ['GET /drive/links/:id/thumbnails', []],
]);

/* The routes that let people in, change roles or seal family keys (docs/optional-verification.md 7.3). */
const FAMILY_CHANGES = new Set([
    'POST /groups/:id/rosters',
    'PUT /groups/:id/key-seals',
    'POST /groups/:id/key-successions',
    'POST /groups/:id/members/:userId/admit',
    'PATCH /groups/:id/members/:userId',
    'POST /groups/:id/members/:userId/remove',
    'POST /groups/:id/areas',
    'POST /groups/:id/areas/:workspaceId/grants',
    'POST /groups/:id/areas/:workspaceId/rotations',
    'PUT /groups/:id/areas/:workspaceId/previous-root',
    'POST /groups/:id/areas/:workspaceId/delete',
]);

/* What each route must check, by its path; auth's routes check their tokens in @hushos/auth. */
function expected(route: Route): string[] | null {
    const k = key(route);
    const path = route.path.replace(/^\/api/, '');
    // CORS answers preflights for the whole API, before any route.
    if (route.method === 'OPTIONS') return null;
    if (PUBLIC.has(k) || path.startsWith('/auth/')) return null;
    if (path.startsWith('/admin/') || path.startsWith('/billing/affiliates'))
        return ['sameOrigin', 'operatorOnly'];
    if (path === '/billing' || path.startsWith('/billing/')) return ['sameOrigin', 'signedIn'];
    if (path.startsWith('/drive/')) return ['sameOrigin', 'namedClient', 'signedIn'];
    if (path.startsWith('/groups') || path.startsWith('/invitations'))
        return [
            'groupsOffered',
            'sameOrigin',
            'namedClient',
            'signedIn',
            ...(FAMILY_CHANGES.has(k) ? ['familyChangeFloor'] : []),
        ];
    throw new Error(`${k}: a route outside every feature; say who may call it`);
}

describe('every API route runs its feature’s checks', () => {
    test('the route table is the whole API', () => {
        expect(routes.length).toBeGreaterThan(180);
    });

    test('each guarded route runs exactly its checks, in order', () => {
        const wrong: string[] = [];
        for (const route of routes) {
            const want = expected(route);
            // Public and auth routes check what they check themselves.
            if (want === null) continue;
            const ours = checks(route);
            // The family-change floor is a route's own option, so it runs after the guard's.
            if (JSON.stringify(ours) !== JSON.stringify(want))
                wrong.push(`${key(route)}: has [${ours.join(', ')}], needs [${want.join(', ')}]`);
        }
        expect(wrong).toEqual([]);
    });

    test('the public routes are all there, each running exactly its checks', () => {
        const present = new Set(routes.map(key));
        for (const route of PUBLIC.keys()) expect(present, route).toContain(route);
        for (const route of routes.filter((r) => PUBLIC.has(key(r))))
            expect(checks(route), key(route)).toEqual(PUBLIC.get(key(route)));
    });
});

describe('a request with no session', () => {
    const CLIENT = { 'HushOS-Client': 'web/99.0.0' };
    const fill = (path: string) =>
        path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

    test('is turned away from every guarded read with 401, or 404 from the operator’s side', async () => {
        const reads = routes.filter((r) => r.method === 'GET' && expected(r) !== null);
        expect(reads.length).toBeGreaterThan(40);
        const answered: string[] = [];
        for (const route of reads) {
            const response = await handle(
                new Request(`http://localhost${fill(route.path)}`, { headers: CLIENT }),
            );
            const admin = expected(route)!.includes('operatorOnly');
            // A route with a query or params schema refuses this made-up request with 400 before
            // any check: still nothing read. Every other one must say who may ask.
            const validated = Boolean(route.hooks?.query || route.hooks?.params);
            const ok =
                response.status === 401 ||
                (admin && response.status === 404) ||
                (validated && response.status === 400);
            if (!ok) answered.push(`${key(route)}: ${response.status}`);
        }
        expect(answered).toEqual([]);
    });
});
