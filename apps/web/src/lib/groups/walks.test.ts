import { describe, expect, test } from 'vitest';
import type { SpaceList } from './api';
import { backoffDelay, ownReasonToWalk, stillRunning, walkToEnd } from './walks';

/*
 * The rules a family folder's walk runs by: a 404 is "ended elsewhere" only
 * once route 25 no longer lists the run, and a device walks in the
 * background only a roster rotation it saw re-key the top folder itself.
 */

const GROUP = 'g1';
const WS = 'ws1';
const run = { workspaceId: WS, rotationId: 'run-1', nodeId: 'root', targetEpoch: 40 };
const notFound = Object.assign(new Error('No rotation is running here.'), { status: 404 });

function spaces(rotation: { id: string; nodeId: string; targetEpoch: number } | null) {
    return [
        {
            space: { kind: 'group', groupId: GROUP, name: 'Lindqvist' },
            areas: [{ workspaceId: WS, rotation }],
        },
    ] as unknown as SpaceList;
}

describe('a walk that answers 404', () => {
    test('counts as ended elsewhere only once route 25 no longer lists the run', async () => {
        const walk = async () => {
            throw notFound;
        };
        await expect(walkToEnd({ walk, running: async () => false })).resolves.toBe(
            'ended-elsewhere',
        );
        // Still listed: a node that won't list, or access that ended. Said, and not counted.
        await expect(walkToEnd({ walk, running: async () => true })).rejects.toBe(notFound);
    });

    test('any other failure is the walk failing, and a walk to its end is walked', async () => {
        const other = Object.assign(new Error('unavailable'), { status: 503 });
        let asked = false;
        await expect(
            walkToEnd({
                walk: async () => {
                    throw other;
                },
                running: async () => {
                    asked = true;
                    return false;
                },
            }),
        ).rejects.toBe(other);
        expect(asked).toBe(false);
        await expect(walkToEnd({ walk: async () => {}, running: async () => true })).resolves.toBe(
            'walked',
        );
    });

    test('route 25 says whether that very run still runs', () => {
        expect(
            stillRunning(spaces({ id: 'run-1', nodeId: 'root', targetEpoch: 40 }), GROUP, run),
        ).toBe(true);
        // Another run of the folder, or none, or a folder not listed: not this one.
        expect(
            stillRunning(spaces({ id: 'run-2', nodeId: 'root', targetEpoch: 41 }), GROUP, run),
        ).toBe(false);
        expect(stillRunning(spaces(null), GROUP, run)).toBe(false);
        expect(stillRunning(spaces(null), 'another-group', run)).toBe(false);
        // Without an id, the node and target decide.
        expect(
            stillRunning(spaces({ id: 'run-9', nodeId: 'root', targetEpoch: 40 }), GROUP, {
                ...run,
                rotationId: null,
            }),
        ).toBe(true);
    });
});

describe('which walks a device starts on its own', () => {
    const state = (over: {
        rotation?: { id: string; nodeId: string; targetEpoch: number } | null;
        root?: { id: string; keyEpoch: number } | null;
        rootListed?: boolean;
        opened?: boolean;
    }) =>
        ({
            opened: over.opened === false ? null : { version: 2 },
            rootListed: over.rootListed ?? true,
            view: {
                rotation:
                    over.rotation === undefined
                        ? { id: 'run-1', nodeId: 'root', targetEpoch: 40 }
                        : over.rotation,
                root: over.root === undefined ? { id: 'root', keyEpoch: 40 } : over.root,
            },
        }) as unknown as Parameters<typeof ownReasonToWalk>[0];

    test('a roster rotation whose top folder opened here at the target epoch', () => {
        expect(ownReasonToWalk(state({}))).toBe(true);
    });

    test('never a run the server names on its own word', () => {
        // A Drive walk of a subtree, or a target the top folder was not re-keyed at.
        expect(
            ownReasonToWalk(state({ rotation: { id: 'r', nodeId: 'sub', targetEpoch: 40 } })),
        ).toBe(false);
        expect(
            ownReasonToWalk(state({ rotation: { id: 'r', nodeId: 'root', targetEpoch: 55 } })),
        ).toBe(false);
        // A top folder that did not open here under the folder's latest key, or a folder not opened.
        expect(ownReasonToWalk(state({ rootListed: false }))).toBe(false);
        expect(ownReasonToWalk(state({ opened: false }))).toBe(false);
        expect(ownReasonToWalk(state({ rotation: null }))).toBe(false);
    });
});

describe('which folders a running walk has yet to reach', () => {
    const rotation = { targetEpoch: 40 };
    test('by the walk’s own rule: the key epoch, or below the top folder the envelope’s parent epoch', async () => {
        const { keyChangeAhead } = await import('./sync');
        // Not re-keyed yet.
        expect(keyChangeAhead(rotation, { keyEpoch: 12, parentKeyEpoch: 40, parentId: 'p' })).toBe(
            true,
        );
        // Its own key is new (made after the target was drawn), but still wrapped under its
        // parent's old key: the walk has not re-wrapped it, so writes into it still wait.
        expect(keyChangeAhead(rotation, { keyEpoch: 44, parentKeyEpoch: 12, parentId: 'p' })).toBe(
            true,
        );
        // Reached on both counts.
        expect(keyChangeAhead(rotation, { keyEpoch: 44, parentKeyEpoch: 40, parentId: 'p' })).toBe(
            false,
        );
        // A top folder's envelope is under its area's key version (2), which is no node epoch.
        expect(keyChangeAhead(rotation, { keyEpoch: 40, parentKeyEpoch: 2, parentId: null })).toBe(
            false,
        );
        expect(keyChangeAhead(null, { keyEpoch: 1, parentKeyEpoch: 1, parentId: 'p' })).toBe(false);
    });
});

describe('a run that keeps coming back', () => {
    test('waits twice as long each time, from 30 seconds, never past 10 minutes', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n))).toEqual([
            30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
        ]);
    });
});
