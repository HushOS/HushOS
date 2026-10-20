import { describe, expect, test } from 'vitest';
import type { SpaceList } from './api';
import {
    backoffDelay,
    ownReasonToWalk,
    stillRunning,
    walkPollDelay,
    walkRetries,
    walkToEnd,
} from './walks';

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

describe('walkRetries', () => {
    /* A clock the test moves, and the timers it would have set. */
    function clock() {
        let now = 0;
        const timers: { at: number; run: () => void; live: boolean }[] = [];
        return {
            now: () => now,
            schedule: (run: () => void, ms: number) => {
                const timer = { at: now + ms, run, live: true };
                timers.push(timer);
                return timer;
            },
            cancel: (handle: unknown) => {
                (handle as { live: boolean }).live = false;
            },
            advance(ms: number) {
                now += ms;
                for (const timer of timers)
                    if (timer.live && timer.at <= now) {
                        timer.live = false;
                        timer.run();
                    }
            },
        };
    }

    test('a failed walk is tried again when its wait ends, however often anyone asks meanwhile', () => {
        const time = clock();
        const retries = walkRetries(time);
        let retried = 0;
        retries.ended('w:r', () => retried++);
        const next = retries.nextAt('w:r');
        expect(next).toBe(30_000);
        // Every render and sync of the family's pages asks; none of it moves the retry.
        for (let i = 0; i < 100; i++) {
            expect(retries.due('w:r')).toBe(false);
            time.advance(100);
        }
        expect(retries.nextAt('w:r')).toBe(next);
        expect(retried).toBe(0);
        time.advance(next! - time.now());
        expect(retried).toBe(1);
        expect(retries.due('w:r')).toBe(true);
    });

    test('the same run failing again waits twice as long, with one retry pending, never two', () => {
        const time = clock();
        const retries = walkRetries(time);
        let retried = 0;
        retries.ended('w:r', () => retried++);
        time.advance(30_000);
        retries.ended('w:r', () => retried++);
        expect(retries.nextAt('w:r')).toBe(90_000);
        time.advance(59_999);
        expect(retried).toBe(1);
        time.advance(1);
        expect(retried).toBe(2);
        // A walk that ended well schedules nothing: the run is over, or a sync says otherwise.
        retries.ended('w:r');
        time.advance(10 * 60_000);
        expect(retried).toBe(2);
    });
});

describe('walkRetries.run', () => {
    test('syncs that find the run while it is being walked join nothing: one failure, one attempt', async () => {
        let now = 0;
        const scheduled: number[] = [];
        const retries = walkRetries({
            now: () => now,
            schedule: (_run, ms) => scheduled.push(ms),
            cancel: () => {},
        });
        let fail!: (error: Error) => void;
        let walks = 0;
        const walk = () => {
            walks++;
            return new Promise<void>((_resolve, reject) => (fail = reject));
        };
        const then = { walked: () => {}, retry: () => {} };
        // Four pages sync while the walk runs; each asks to walk the run.
        for (let i = 0; i < 4; i++) retries.run('w:r', walk, then);
        expect(walks).toBe(1);
        fail(new Error('Fetch is aborted'));
        await Promise.resolve();
        await Promise.resolve();
        // One failure: the first wait (30 s), not the fourth's (four minutes).
        expect(scheduled).toEqual([30_000]);
        expect(retries.nextAt('w:r')).toBe(30_000);
        now = 30_000;
        retries.run('w:r', walk, then);
        expect(walks).toBe(2);
    });
});

describe('walkPollDelay', () => {
    test('a function of the clock: asking again at the same moment gives the same wait', () => {
        const waits = Array.from({ length: 50 }, () => walkPollDelay(1_000, 1_000, 15_000));
        expect(new Set(waits)).toEqual(new Set([15_000]));
    });

    test('doubles with each doubling of the time the walk has run, up to ten minutes', () => {
        expect(
            [0, 14_999, 15_000, 44_999, 45_000, 105_000, 3_600_000].map((elapsed) =>
                walkPollDelay(0, elapsed, 15_000),
            ),
        ).toEqual([15_000, 15_000, 30_000, 30_000, 60_000, 120_000, 600_000]);
    });
});
