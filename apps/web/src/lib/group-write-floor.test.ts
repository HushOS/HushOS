import { checkClient, parseMinimums } from '@hushos/drive/protocol';
import { GROUP_WRITE_HEADER, GROUP_WRITE_PROTOCOL } from '@hushos/groups/protocol';
import { describe, expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import source from './api.server.ts?raw';
import clientSource from './api-client.ts?raw';
import { followsGroupWrites, groupWriteMinimums } from './group-write-floor';
import { HUSHOS_VERSION } from './version';

/*
 * The client floor on family-changing routes (docs/optional-verification.md
 * 7.3): a web tab that follows older family-write rules (it sends an older
 * number, or none) is refused with 426 on the routes that let people in,
 * change roles or seal family keys, and served everywhere else, Drive and the
 * join's own routes included, whatever release version it names: hushos.com
 * deploys without bumping it. Only `web/` is held to the number, so an iOS
 * 0.10.0 phone keeps joining. GROUP_WRITE_CLIENT_MINIMUMS only raises the
 * version floor.
 */

const none = parseMinimums(undefined);

describe('the family-write number', () => {
    test('a web tab without it, or with an older one, is refused; this one passes, whatever the release', () => {
        // The same release version on both: only the number tells them apart.
        expect(checkClient(`web/${HUSHOS_VERSION}`, groupWriteMinimums(none, none))).toMatchObject({
            ok: true,
        });
        expect(followsGroupWrites('web', null)).toBe(false);
        expect(followsGroupWrites('web', undefined)).toBe(false);
        expect(followsGroupWrites('web', '')).toBe(false);
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL - 1))).toBe(false);
        expect(followsGroupWrites('web', 'two')).toBe(false);
        expect(followsGroupWrites('web', '2.5')).toBe(false);
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL))).toBe(true);
        // A later tab against this server (a rollback): served, as a newer release is.
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL + 1))).toBe(true);
    });

    test('the phones aren’t asked for it: iOS 0.10.0 sends none and keeps joining', () => {
        expect(followsGroupWrites('ios', null)).toBe(true);
        expect(followsGroupWrites('android', null)).toBe(true);
    });

    test('the web client sends it on every request', () => {
        expect(GROUP_WRITE_HEADER).toBe('HushOS-Group-Write');
        expect(clientSource).toMatch(
            /headers: \{\s*\[CLIENT_HEADER\]: `web\/\$\{HUSHOS_VERSION\}`,\s*\[GROUP_WRITE_HEADER\]: String\(GROUP_WRITE_PROTOCOL\),\s*\}/,
        );
    });
});

describe('the family-change version floor', () => {
    test('has none built in: today’s release is served, and every client name is served unless an operator sets one', () => {
        const floor = groupWriteMinimums(none, none);
        expect(floor.size).toBe(0);
        expect(checkClient(`web/${HUSHOS_VERSION}`, floor)).toMatchObject({ ok: true });
        expect(checkClient('ios/0.10.0', floor)).toMatchObject({ ok: true });
        const set = groupWriteMinimums(none, parseMinimums('ios/0.11.0'));
        expect(checkClient('ios/0.10.0', set)).toMatchObject({ status: 426 });
    });

    test('GROUP_WRITE_CLIENT_MINIMUMS raises it over DRIVE_CLIENT_MINIMUMS and never lowers it', () => {
        const raised = groupWriteMinimums(none, parseMinimums('web/999.0.0'));
        expect(checkClient(`web/${HUSHOS_VERSION}`, raised)).toMatchObject({ status: 426 });
        // Lower than Drive's own: Drive's stands.
        const lowered = groupWriteMinimums(parseMinimums('web/2.0.0'), parseMinimums('web/1.0.0'));
        expect(lowered.get('web')).toBe('2.0.0');
        // A pre-1.0 protocol floor is below every product version.
        expect(
            groupWriteMinimums(parseMinimums('web/1.0.0'), parseMinimums('web/9')).get('web'),
        ).toBe('1.0.0');
        // Drive's own minimum, when higher, is the floor here as well.
        expect(groupWriteMinimums(parseMinimums('web/999.1.0'), none).get('web')).toBe('999.1.0');
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
        // And the helper checks the floor and the number itself, before the session, with 426
        // (e2e/families.spec.ts drops the number on a running server and gets 426 there).
        expect(source).toMatch(
            /async function groupWriter\([^)]*\) \{\s*const client = requireClient\(request, groupWriteFloor\);\s*if \(!followsGroupWrites\(client\.name, request\.headers\.get\(GROUP_WRITE_HEADER\)\)\)\s*throw new drive\.DriveError\(\s*'unsupported',[^)]*426,\s*\);\s*return groupUser\(/,
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
