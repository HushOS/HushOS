// @vitest-environment node
import { groupLogAction } from '@hushos/logging';
import { expect, test } from 'vitest';
import { loadApi, type ApiRoute } from '@/test/api-app';

/*
 * Group routes carry group, account, area and invitation ids in their paths:
 * the log keeps only each route's pattern, from an allowlist in the logging
 * package. A route added here and not there would be logged as "unknown".
 */
test('every group route is logged under its own pattern', async () => {
    const routes = (await loadApi()).routes as unknown as ApiRoute[];
    const paths = [
        ...new Set(
            routes.map((r) => r.path).filter((p) => /^\/api\/(groups|invitations)(\/|$)/.test(p)),
        ),
    ];
    expect(paths.length).toBeGreaterThan(20);
    const uuid = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
    const real = paths.map((path) => path.replace(/:[^/]+/g, uuid));
    expect(real.filter((path) => groupLogAction(path) === 'unknown')).toEqual([]);
    // Ids never survive into the action.
    expect(real.map(groupLogAction).filter((action) => action.includes(uuid))).toEqual([]);
});

test('an unknown group path is logged as unknown, a known one by its pattern', () => {
    expect(groupLogAction('/api/groups/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4/secret')).toBe(
        'unknown',
    );
    expect(
        groupLogAction(
            '/api/groups/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4/members/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4/admit',
        ),
    ).toBe('groups/:id/members/:userId/admit');
    expect(
        groupLogAction(
            '/api/groups/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4/areas/0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4/root',
        ),
    ).toBe('groups/:id/areas/:workspaceId/root');
    expect(groupLogAction('/api/groups/0B7F1C2E-3D4A-4B5C-8D6E-7F8091A2B3C4/rosters')).toBe(
        'groups/:id/rosters',
    );
});
