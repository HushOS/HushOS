import { describe, expect, test } from 'vitest';
import type { SpaceList } from './api';
import {
    backoffDelay,
    ownReasonToWalk,
    stillRunning,
    walkPollDelay,
    familyWalks,
    walkEndings,
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

/*
 * A clock the test moves: timers run on its own timeline (monotonic, as setTimeout's), and
 * `now()` reads that timeline plus `step`, so a test can move the wall clock under the timers.
 */
function testClock() {
    let t = 0;
    let step = 0;
    const timers: { at: number; run: () => void; live: boolean }[] = [];
    return {
        now: () => t + step,
        schedule: (run: () => void, ms: number) => {
            const timer = { at: t + ms, run, live: true };
            timers.push(timer);
            return timer;
        },
        cancel: (handle: unknown) => {
            (handle as { live: boolean }).live = false;
        },
        advance(ms: number) {
            t += ms;
            for (const timer of timers)
                if (timer.live && timer.at <= t) {
                    timer.live = false;
                    timer.run();
                }
        },
        stepWallClock(ms: number) {
            step += ms;
        },
        get elapsed() {
            return t;
        },
    };
}
/* No jitter: random() = 0.5 is a factor of exactly 1. */
const even = () => 0.5;
const countedFailure = { judge: () => 'counted' as const };

describe('walkRetries', () => {
    test('a failed walk is tried again when its wait ends, however often anyone asks meanwhile', () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let retried = 0;
        expect(retries.ended('w:r', { retry: () => retried++ })).toBe(30_000);
        // Every render and sync of the family's pages asks; none of it moves the retry.
        for (let i = 0; i < 100; i++) {
            expect(retries.due('w:r')).toBe(false);
            time.advance(100);
        }
        expect(retries.nextAt('w:r')).toBe(30_000);
        expect(retried).toBe(0);
        time.advance(30_000 - time.elapsed);
        expect(retried).toBe(1);
        expect(retries.due('w:r')).toBe(true);
    });

    test('failing again before the retry fired: twice the wait from then, and that retry alone', () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        const fired: string[] = [];
        retries.ended('w:r', { retry: () => fired.push('first') });
        // A retry's sync failed (or another walk did) at 10 s, while the first retry waits.
        time.advance(10_000);
        expect(retries.ended('w:r', { retry: () => fired.push('second') })).toBe(60_000);
        time.advance(20_000);
        // 30 s in: the first retry was replaced, so it never fires.
        expect(fired).toEqual([]);
        time.advance(40_000);
        expect(fired).toEqual(['second']);
        time.advance(10 * 60_000);
        expect(fired).toEqual(['second']);
    });

    test('a walk that ended well schedules nothing', () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let retried = 0;
        retries.ended('w:r', { retry: () => retried++ });
        time.advance(30_000);
        retries.ended('w:r');
        time.advance(10 * 60_000);
        expect(retried).toBe(1);
    });

    test('each wait is the backoff give or take a fifth, never past ten minutes', () => {
        const low = walkRetries(testClock(), () => 0);
        const high = walkRetries(testClock(), () => 0.999_999);
        expect(low.ended('w:r')).toBe(24_000);
        expect(high.ended('w:r')).toBe(36_000);
        for (let i = 0; i < 10; i++) high.ended('w:r');
        expect(high.ended('w:r')).toBe(10 * 60_000);
    });

    test('a walk that re-keyed something before it stopped starts the wait over', () => {
        const retries = walkRetries(testClock(), even);
        retries.ended('w:r');
        expect(retries.ended('w:r')).toBe(60_000);
        expect(retries.ended('w:r')).toBe(120_000);
        expect(retries.ended('w:r', { failure: 'progressed' })).toBe(30_000);
    });

    test('the retry walks when its timer fires, even if the wall clock stepped back meanwhile', async () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let walks = 0;
        const walk = async () => {
            walks++;
        };
        retries.ended('w:r', {
            retry: () => retries.run('w:r', walk, { retry: () => {}, ...countedFailure }),
        });
        // An hour back: by the clock the wait has 30 s plus an hour to go, but its timer fired.
        time.stepWallClock(-60 * 60_000);
        time.advance(30_000);
        expect(walks).toBe(1);
    });

    test('locked or signed out: the run is forgotten, nothing is counted and nothing fires', async () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let retried = 0;
        // Two walks ended: the next waits a minute.
        retries.ended('w:r');
        retries.ended('w:r');
        time.advance(60_000);
        retries.run('w:r', () => Promise.reject(new Error('Unlock your account first.')), {
            retry: () => retried++,
            judge: () => 'gone',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Forgotten: due now, with no wait of its own, and no retry lined up.
        expect(retries.due('w:r')).toBe(true);
        expect(retries.nextAt('w:r')).toBeNull();
        time.advance(60 * 60_000);
        expect(retried).toBe(0);
        // Its count went with it: the next walk that ends waits the first wait.
        expect(retries.ended('w:r')).toBe(30_000);
    });

    test('offline: no timer; back online it is walked again at once, its count started over', () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let retried = 0;
        retries.ended('w:r');
        retries.ended('w:r');
        expect(retries.ended('w:r', { retry: () => retried++, failure: 'offline' })).toBeNull();
        time.advance(60 * 60_000);
        expect(retried).toBe(0);
        retries.online();
        expect(retried).toBe(1);
        expect(retries.ended('w:r')).toBe(30_000);
    });

    test('clear: no retry fires, and a walk settling after it leaves nothing behind', async () => {
        const time = testClock();
        const retries = walkRetries(time, even);
        let retried = 0;
        retries.ended('w:r', { retry: () => retried++ });
        let fail!: (error: Error) => void;
        retries.run('w:other', () => new Promise((_resolve, reject) => (fail = reject)), {
            retry: () => retried++,
            ...countedFailure,
        });
        retries.clear();
        fail(new Error('Unlock your account first.'));
        await Promise.resolve();
        await Promise.resolve();
        time.advance(60 * 60_000);
        expect(retried).toBe(0);
        expect(retries.nextAt('w:r')).toBeNull();
        expect(retries.nextAt('w:other')).toBeNull();
    });
});

describe('walkRetries.run', () => {
    test('syncs that find the run while it is being walked join nothing: one failure, one attempt', async () => {
        const time = testClock();
        const scheduled: number[] = [];
        const retries = walkRetries(
            { now: time.now, schedule: (_run, ms) => scheduled.push(ms), cancel: () => {} },
            even,
        );
        let fail!: (error: Error) => void;
        let walks = 0;
        const walk = () => {
            walks++;
            return new Promise<void>((_resolve, reject) => (fail = reject));
        };
        const then = { retry: () => {}, ...countedFailure };
        // Four pages sync while the walk runs; each asks to walk the run.
        for (let i = 0; i < 4; i++) retries.run('w:r', walk, then);
        expect(walks).toBe(1);
        fail(new Error('Fetch is aborted'));
        await Promise.resolve();
        await Promise.resolve();
        // One failure: the first wait (30 s), not the fourth's (four minutes).
        expect(scheduled).toEqual([30_000]);
        expect(retries.nextAt('w:r')).toBe(30_000);
        time.advance(30_000);
        retries.run('w:r', walk, then);
        expect(walks).toBe(2);
    });
});

/*
 * The wiring lib/spaces.ts runs: walks of what a sync found, retries through a sync of the
 * family, and the family's pages hearing each walk end. The folder walks, syncs, lock state and
 * network are injected; everything between them is the code the app runs.
 */
describe('familyWalks', () => {
    const state = {
        workspaceId: WS,
        opened: { version: 2 },
        rootListed: true,
        view: {
            rotation: { id: 'run-1', nodeId: 'root', targetEpoch: 40 },
            root: { id: 'root', keyEpoch: 40 },
        },
    } as unknown as Parameters<typeof ownReasonToWalk>[0] & { workspaceId: string };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const cutOff = () => Promise.reject(new Error('signal timed out'));

    function harness() {
        const time = testClock();
        const h = {
            time,
            user: 'u1' as string | null,
            online: true,
            progressed: false,
            walks: 0,
            syncs: 0,
            heard: 0,
            /* What each walk of the folder does, in turn; then each walks to its end. */
            outcomes: [] as (() => Promise<void>)[],
            /* What each sync answers: the folder still walking, unless a test holds one. */
            syncAnswer: (): Promise<readonly unknown[] | null> => Promise.resolve([state]),
            scheduled: [] as (number | 'online' | null)[],
        };
        const endings = walkEndings();
        endings.subscribe(GROUP, () => h.heard++);
        const walks = familyWalks({
            walkFolder: async () => {
                h.walks++;
                await (h.outcomes.shift() ?? (async () => {}))();
            },
            sync: async () => {
                h.syncs++;
                // Locked or signed out, the sync can't open the family.
                if (h.user === null) throw new Error('Unlock your account first.');
                return (await h.syncAnswer()) as never;
            },
            unlockedUser: () => h.user,
            online: () => h.online,
            progressed: () => h.progressed,
            scheduled: (_workspaceId, next) => h.scheduled.push(next),
            endings,
            clock: time,
            random: even,
        });
        return { h, walks };
    }

    test('a failed run is walked again 30 s later by itself, and the family’s pages hear it end', async () => {
        const { h, walks } = harness();
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        expect(h.scheduled).toEqual([30_000]);
        h.time.advance(29_999);
        await settle();
        expect([h.syncs, h.walks]).toEqual([0, 1]);
        h.time.advance(1);
        await settle();
        expect([h.syncs, h.walks, h.heard]).toEqual([1, 2, 1]);
    });

    test('a retry that joins a sync already running for an upload still walks, and is heard', async () => {
        const { h, walks } = harness();
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        // 20 s in, an upload waiting on the key change syncs the family; its answer is slow.
        const slow = deferred<readonly unknown[] | null>();
        h.syncAnswer = () => slow.promise;
        h.time.advance(20_000);
        void walks.refresh('u1', GROUP);
        await settle();
        expect(h.syncs).toBe(1);
        // The retry comes due while that sync runs: it joins it rather than syncing again.
        h.time.advance(10_000);
        await settle();
        expect(h.syncs).toBe(1);
        slow.resolve([state]);
        await settle();
        expect([h.syncs, h.walks, h.heard]).toEqual([1, 2, 1]);
    });

    test('a retry right after an upload’s sync isn’t skipped as too soon after it', async () => {
        const { h, walks } = harness();
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        // 28 s in, an upload's sync finds the run still waiting out its first wait.
        h.time.advance(28_000);
        await walks.refresh('u1', GROUP);
        await settle();
        expect([h.syncs, h.walks]).toEqual([1, 1]);
        // 2 s later the retry is due: it syncs, within the gap uploads keep, and walks.
        h.time.advance(2_000);
        await settle();
        expect([h.syncs, h.walks, h.heard]).toEqual([2, 2, 1]);
    });

    test('a walk an upload’s sync started is heard to end too', async () => {
        const { h, walks } = harness();
        await walks.refresh('u1', GROUP);
        await settle();
        expect([h.syncs, h.walks, h.heard]).toEqual([1, 1, 1]);
    });

    test('locked for an hour: nothing is counted or synced; unlocked, the first sync walks it at once', async () => {
        const { h, walks } = harness();
        // It failed while unlocked; the account locked 10 s later, while the retry waited.
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        h.time.advance(10_000);
        h.user = null;
        for (let i = 0; i < 60; i++) {
            h.time.advance(60_000);
            await settle();
        }
        expect(h.syncs).toBe(0);
        // Unlocked: the page's sync finds the run, and it is walked then, not minutes later.
        h.user = 'u1';
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        expect(h.walks).toBe(2);
        // Its count started over: the next try is 30 s out, not at the ten-minute cap.
        expect(h.scheduled.at(-1)).toBe(30_000);
    });

    test('a walk the lock cut short counts nothing and lines nothing up', async () => {
        const { h, walks } = harness();
        h.outcomes.push(async () => {
            h.user = null;
            throw new Error('Unlock your account first.');
        });
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        expect(h.scheduled).toEqual([null]);
        h.time.advance(60 * 60_000);
        await settle();
        expect(h.syncs).toBe(0);
        h.user = 'u1';
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        expect([h.walks, h.heard]).toEqual([2, 1]);
    });

    test('signed out (clear): the retry never fires, so nothing syncs for the account that left', async () => {
        const { h, walks } = harness();
        h.outcomes.push(cutOff);
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        walks.clear();
        h.time.advance(60 * 60_000);
        await settle();
        expect([h.syncs, h.walks]).toEqual([0, 1]);
    });

    test('offline: no timer runs; back online, it is walked again at once', async () => {
        const { h, walks } = harness();
        h.online = false;
        h.outcomes.push(() => Promise.reject(new Error('Failed to fetch')));
        walks.pending('u1', GROUP, [state as never]);
        await settle();
        expect(h.scheduled).toEqual(['online']);
        h.time.advance(60 * 60_000);
        await settle();
        expect(h.syncs).toBe(0);
        h.online = true;
        walks.online();
        await settle();
        expect([h.syncs, h.walks, h.heard]).toEqual([1, 2, 1]);
    });
});

describe('walkPollDelay', () => {
    test('doubles with each doubling of the time the walk has run, up to ten minutes', () => {
        expect(
            [0, 14_999, 15_000, 44_999, 45_000, 105_000, 3_600_000].map((elapsed) =>
                walkPollDelay(0, elapsed, 15_000),
            ),
        ).toEqual([15_000, 15_000, 30_000, 30_000, 60_000, 120_000, 600_000]);
    });
});
