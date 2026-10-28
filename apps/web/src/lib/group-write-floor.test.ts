import { checkClient, parseMinimums } from '@hushos/drive/protocol';
import { describe, expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';
import { GROUP_WRITE_WEB_FLOOR, groupWriteMinimums } from './group-write-floor';
import { HUSHOS_VERSION } from './version';

/*
 * The client floor on family-changing routes (docs/optional-verification.md
 * 7.3): a web tab older than this release is refused with 426 on the routes
 * that let people in, change roles or seal family keys, and served everywhere
 * else, Drive and the join's own routes included. GROUP_WRITE_CLIENT_MINIMUMS
 * only raises the floor, and only `web/` is built in, so an iOS 0.10.0 phone
 * keeps joining.
 */

const below = (version: string) => {
    const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
    return patch > 0
        ? `${major}.${minor}.${patch - 1}`
        : minor > 0
          ? `${major}.${minor - 1}.0`
          : `${major - 1}.0.0`;
};
const none = parseMinimums(undefined);

describe('the family-change floor', () => {
    test('is built in for the web at this release: an older tab gets 426 there, and is served everywhere else', () => {
        expect(GROUP_WRITE_WEB_FLOOR).toBe(HUSHOS_VERSION);
        const floor = groupWriteMinimums(none, none);
        const old = `web/${below(HUSHOS_VERSION)}`;
        expect(checkClient(old, floor)).toMatchObject({ ok: false, status: 426 });
        expect(checkClient(`web/${HUSHOS_VERSION}`, floor)).toMatchObject({ ok: true });
        // The same tab on every other route (Drive's minimums, here none at all): served.
        expect(checkClient(old, none)).toMatchObject({ ok: true });
    });

    test('GROUP_WRITE_CLIENT_MINIMUMS raises it and never lowers it, and DRIVE_CLIENT_MINIMUMS counts too', () => {
        const raised = groupWriteMinimums(none, parseMinimums('web/999.0.0'));
        expect(raised.get('web')).toBe('999.0.0');
        expect(checkClient(`web/${HUSHOS_VERSION}`, raised)).toMatchObject({ status: 426 });
        // Lower than the built-in floor: the built-in floor stands.
        const lowered = groupWriteMinimums(none, parseMinimums('web/0.0.1'));
        expect(lowered.get('web')).toBe(HUSHOS_VERSION);
        expect(checkClient(`web/${below(HUSHOS_VERSION)}`, lowered)).toMatchObject({ status: 426 });
        // A pre-1.0 protocol floor is below every product version.
        expect(groupWriteMinimums(none, parseMinimums('web/9')).get('web')).toBe(HUSHOS_VERSION);
        // Drive's own minimum, when higher, is the floor here as well.
        expect(groupWriteMinimums(parseMinimums('web/999.1.0'), none).get('web')).toBe('999.1.0');
    });

    test('builds in no floor for the phones: iOS 0.10.0 is served unless an operator sets one', () => {
        const floor = groupWriteMinimums(none, none);
        expect(floor.has('ios')).toBe(false);
        expect(checkClient('ios/0.10.0', floor)).toMatchObject({ ok: true });
        expect(checkClient('android/0.10.0', floor)).toMatchObject({ ok: true });
        const set = groupWriteMinimums(none, parseMinimums('ios/0.11.0'));
        expect(checkClient('ios/0.10.0', set)).toMatchObject({ status: 426 });
        expect(set.get('web')).toBe(HUSHOS_VERSION);
    });
});

/*
 * Every route, by method and path, as api.server.ts mounts it, with the helper its handler
 * calls first: groupWriter (floored) or groupUser.
 */
function routes() {
    const out = new Map<string, string>();
    const pattern = /\.(get|post|put|patch|delete)\(\s*'((?:\/groups|\/invitations)[^']*)'/g;
    const found = [...source.matchAll(pattern)];
    for (const [index, match] of found.entries()) {
        const end = found[index + 1]?.index ?? source.indexOf('\n    )', match.index);
        const body = source.slice(match.index, end);
        const helper = /\(await (groupWriter|groupUser)\(request, sessionToken\)\)/.exec(body);
        // Each handler's first call into the groups package takes the helper's user: nothing
        // is read or stored before the client is checked.
        const first = /groups\.\w+\(\s*\(await (groupWriter|groupUser)\(/.exec(body);
        out.set(`${match[1]!.toUpperCase()} ${match[2]}`, first?.[1] ?? helper?.[1] ?? 'none');
    }
    return out;
}

describe('which routes are floored (7.3)', () => {
    const FLOORED = [
        'POST /groups/:id/rosters', // 7
        'PUT /groups/:id/key-seals', // 9
        'POST /groups/:id/key-successions', // 10
        'POST /groups/:id/members/:userId/admit', // 17
        'PATCH /groups/:id/members/:userId', // 18
        'POST /groups/:id/members/:userId/remove', // 19
        'POST /groups/:id/areas', // 21
        'POST /groups/:id/areas/:workspaceId/grants', // 22
        'POST /groups/:id/areas/:workspaceId/rotations', // 24
        'PUT /groups/:id/areas/:workspaceId/previous-root', // 28
        'POST /groups/:id/areas/:workspaceId/delete', // 30
    ].sort();

    test('the routes that let people in, change roles or seal family keys, and only those, check the floor first', () => {
        const all = routes();
        expect(all.size).toBeGreaterThan(25);
        const floored = [...all].filter(([, helper]) => helper === 'groupWriter').map(([r]) => r);
        expect(floored.sort()).toEqual(FLOORED);
        // And the helper checks the floor itself, before the session (e2e/families.spec.ts sends an
        // old client header to a running server and gets 426 there).
        expect(source).toMatch(
            /async function groupWriter\([^)]*\) \{\s*requireClient\(request, groupWriteFloor\);\s*return groupUser\(/,
        );
        expect(source).toMatch(
            /groupWriteMinimums\(\s*clientMinimums,\s*parseMinimums\(storageEnv\.GROUP_WRITE_CLIENT_MINIMUMS\)/,
        );
        // Everything else, the join's own routes (invitations, accepting, the self-grant) and
        // every read included, keeps serving an older client.
        for (const route of [
            'GET /groups/:id/rosters',
            'GET /groups/:id/identities',
            'GET /groups/:id/key-seal',
            'POST /invitations/open',
            'POST /invitations/accept',
            'GET /invitations',
            'POST /groups/:id/leave',
            'POST /groups/:id/members/:userId/decline',
            'POST /groups/:id/members/:userId/hold',
            'PUT /groups/:id/areas/:workspaceId/self-grant',
        ])
            expect(all.get(route), route).toBe('groupUser');
    });
});
