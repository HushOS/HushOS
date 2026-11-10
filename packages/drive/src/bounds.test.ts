import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    STORE_BOUNDS,
    StoreDeadlineError,
    StoreUnavailableError,
    createBreaker,
    createGuard,
    createLimiter,
    deadlineFor,
} from './bounds';

/*
 * The breaker, the cap and the total deadline by themselves
 * (docs/company-storage-design.md 2.4), with a clock the test moves. What a
 * real S3 client does under them is in storage.hostile.test.ts.
 */

const BREAKER = { breakerFailures: 5, breakerOpenMs: 60_000, slowCalls: 5, slowMs: 60_000 };

function clock() {
    let at = 1_000_000;
    return { now: () => at, pass: (ms: number) => (at += ms) };
}

/* One admitted call that fails, or succeeds in `tookMs` of 60 s. */
function breakerWith(time = clock()) {
    const breaker = createBreaker(BREAKER, time.now);
    const admitted = () => {
        const pass = breaker.admit();
        if (!pass) throw new Error('refused');
        return pass;
    };
    return {
        breaker,
        time,
        fail: () => breaker.failed(admitted()),
        succeed: (tookMs = 10) => breaker.succeeded(admitted(), tookMs, 60_000),
    };
}

describe('the deadline of a call', () => {
    test('is 60 seconds for a call that carries nothing, and one second more for every 256 KiB expected', () => {
        expect(deadlineFor(STORE_BOUNDS)).toBe(60_000);
        expect(deadlineFor(STORE_BOUNDS, 256 * 1024)).toBe(61_000);
        // One copy part: 64 MiB at the slowest rate still served.
        expect(deadlineFor(STORE_BOUNDS, 64 * 1024 * 1024)).toBe(60_000 + 256_000);
        // A byte is not free: the allowance rounds up, never down to nothing.
        expect(deadlineFor(STORE_BOUNDS, 1)).toBe(60_001);
    });

    test('grows when the operator lowers the rate for a slow link', () => {
        const slowLink = { ...STORE_BOUNDS, bytesPerSecond: 64 * 1024 };
        expect(deadlineFor(slowLink, 64 * 1024 * 1024)).toBe(60_000 + 1_024_000);
    });
});

describe('the breaker', () => {
    test('stays closed through four failures in a row and opens on the fifth', () => {
        const { breaker, fail } = breakerWith();
        for (let i = 0; i < 4; i++) fail();
        expect(breaker.health()).toBe('ok');
        expect(breaker.admit()).not.toBeNull();
        fail();
        expect(breaker.health()).toBe('open');
        expect(breaker.admit()).toBeNull();
    });

    test('counts failures in a row only: an answer in between starts the count again', () => {
        const { breaker, fail, succeed } = breakerWith();
        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 4; i++) fail();
            succeed();
        }
        // Twelve failures, never five together.
        expect(breaker.health()).toBe('ok');
    });

    test('refuses everything for 60 seconds, then admits exactly one trial', () => {
        const { breaker, fail, time } = breakerWith();
        for (let i = 0; i < 5; i++) fail();
        time.pass(59_999);
        expect(breaker.admit()).toBeNull();
        time.pass(1);
        // Half-open: a job may try it, and the first call is the trial.
        expect(breaker.health()).toBe('ok');
        expect(breaker.admit()).toEqual({ trial: true });
        // While the trial is out nothing else goes, and the store reads as open again.
        expect(breaker.admit()).toBeNull();
        expect(breaker.health()).toBe('open');
    });

    test('closes when the trial succeeds, and then needs five new failures to open', () => {
        const { breaker, fail, time } = breakerWith();
        for (let i = 0; i < 5; i++) fail();
        time.pass(60_000);
        breaker.succeeded(breaker.admit()!, 10, 60_000);
        expect(breaker.health()).toBe('ok');
        for (let i = 0; i < 4; i++) fail();
        expect(breaker.admit()).toEqual({ trial: false });
    });

    test('opens for the full time again when the trial fails', () => {
        const { breaker, fail, time } = breakerWith();
        for (let i = 0; i < 5; i++) fail();
        time.pass(60_000);
        breaker.failed(breaker.admit()!);
        expect(breaker.admit()).toBeNull();
        time.pass(59_999);
        expect(breaker.admit()).toBeNull();
        time.pass(1);
        expect(breaker.admit()).toEqual({ trial: true });
    });

    test('is decided by the trial alone: a call admitted before it opened changes nothing when it ends', () => {
        const { breaker, time } = breakerWith();
        // Seven calls in flight at once; five fail and open the breaker.
        const inFlight = Array.from({ length: 7 }, () => breaker.admit()!);
        for (const pass of inFlight.slice(0, 5)) breaker.failed(pass);
        expect(breaker.health()).toBe('open');
        // A straggler that got an answer does not close it.
        breaker.succeeded(inFlight[5]!, 10, 60_000);
        expect(breaker.admit()).toBeNull();
        // And one that fails 50 seconds in does not push the trial back.
        time.pass(50_000);
        breaker.failed(inFlight[6]!);
        time.pass(10_000);
        expect(breaker.admit()).toEqual({ trial: true });
    });

    test('marks a store slow after five successes in a row that each took more than half their deadline', () => {
        const { breaker, succeed, time } = breakerWith();
        for (let i = 0; i < 4; i++) succeed(30_001);
        expect(breaker.health()).toBe('ok');
        succeed(30_001);
        expect(breaker.health()).toBe('slow');
        // Slow refuses nothing: a person's request still goes.
        expect(breaker.admit()).toEqual({ trial: false });
        time.pass(59_999);
        expect(breaker.health()).toBe('slow');
        time.pass(1);
        expect(breaker.health()).toBe('ok');
    });

    test('does not call exactly half the deadline slow, and one success in good time starts the count again', () => {
        const { breaker, succeed } = breakerWith();
        for (let i = 0; i < 20; i++) succeed(30_000);
        expect(breaker.health()).toBe('ok');
        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 4; i++) succeed(59_000);
            succeed(100);
        }
        expect(breaker.health()).toBe('ok');
    });

    test('does not count a failure as a slow success, nor let slow successes hide failures', () => {
        const { breaker, succeed, fail } = breakerWith();
        for (let i = 0; i < 4; i++) succeed(59_000);
        fail();
        succeed(59_000);
        // Four slow, a failure, one slow: never five slow in a row.
        expect(breaker.health()).toBe('ok');
    });
});

describe('the cap', () => {
    const never = new AbortController().signal;

    test('lets `cap` holders in and makes the rest wait, first come first served', async () => {
        const limiter = createLimiter(2);
        const first = await limiter.acquire(never);
        const second = await limiter.acquire(never);
        const order: string[] = [];
        const third = limiter.acquire(never).then((release) => (order.push('third'), release));
        const fourth = limiter.acquire(never).then((release) => (order.push('fourth'), release));
        await Promise.resolve();
        expect(limiter.inFlight()).toBe(2);
        expect(limiter.waiting()).toBe(2);
        expect(order).toEqual([]);

        first();
        const releaseThird = await third;
        expect(order).toEqual(['third']);
        expect(limiter.inFlight()).toBe(2);
        second();
        const releaseFourth = await fourth;
        expect(order).toEqual(['third', 'fourth']);
        releaseThird();
        releaseFourth();
        expect(limiter.inFlight()).toBe(0);
    });

    test('a waiter whose deadline passes leaves the line, and the place it never had is not lost', async () => {
        const limiter = createLimiter(1);
        const held = await limiter.acquire(never);
        const impatient = new AbortController();
        const gaveUp = limiter.acquire(impatient.signal);
        const patient = limiter.acquire(never);
        impatient.abort(new StoreDeadlineError());
        await expect(gaveUp).rejects.toBeInstanceOf(StoreDeadlineError);
        expect(limiter.waiting()).toBe(1);
        held();
        (await patient)();
        expect(limiter.inFlight()).toBe(0);
        // Still one place, not zero and not two.
        const again = await limiter.acquire(never);
        expect(limiter.inFlight()).toBe(1);
        again();
    });

    test('a release called twice frees one place, not two', async () => {
        const limiter = createLimiter(1);
        const release = await limiter.acquire(never);
        release();
        release();
        await limiter.acquire(never);
        const second = limiter.acquire(never);
        await Promise.resolve();
        expect(limiter.inFlight()).toBe(1);
        expect(limiter.waiting()).toBe(1);
        void second;
    });

    test('without a cap nothing waits', async () => {
        const limiter = createLimiter(undefined);
        await Promise.all(Array.from({ length: 50 }, () => limiter.acquire(never)));
        expect(limiter.waiting()).toBe(0);
    });
});

describe('a guarded call', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const bounds = { ...STORE_BOUNDS };
    const guardOf = (options: { cap?: number; answered?: (error: unknown) => boolean } = {}) =>
        createGuard({
            storeId: 'store-under-test',
            bounds,
            cap: options.cap,
            answered: options.answered ?? (() => false),
        });
    const outcome = <T>(call: Promise<T>) =>
        call.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
    const hang = () => new Promise<never>(() => {});

    test('ends at its total deadline even when the work ignores the signal it was given', async () => {
        const guard = guardOf();
        const call = outcome(guard.call(0, hang));
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await Promise.race([call, Promise.resolve('pending')])).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await call).toMatchObject({ error: expect.any(StoreDeadlineError) });
    });

    test('hands the work one signal for every attempt, aborted at the deadline and not before', async () => {
        const guard = guardOf();
        const seen: AbortSignal[] = [];
        const call = outcome(
            guard.call(0, async (signal) => {
                // Three attempts, as the SDK makes them: each is given the same signal.
                for (let attempt = 0; attempt < 3; attempt++) {
                    seen.push(signal);
                    await new Promise((resolve) => setTimeout(resolve, 25_000));
                    if (signal.aborted) throw new Error('aborted attempt');
                }
            }),
        );
        await vi.advanceTimersByTimeAsync(50_000);
        expect(seen).toHaveLength(3);
        expect(new Set(seen).size).toBe(1);
        expect(seen[0]!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen[0]!.aborted).toBe(true);
        // What the cut-off attempt threw is not what the caller sees.
        expect(await call).toMatchObject({ error: expect.any(StoreDeadlineError) });
    });

    test('allows a call its bytes: 64 MiB is not cut off at 60 seconds, and is at 316', async () => {
        const guard = guardOf();
        const call = outcome(guard.call(64 * 1024 * 1024, hang));
        await vi.advanceTimersByTimeAsync(315_999);
        expect(await Promise.race([call, Promise.resolve('pending')])).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(await call).toMatchObject({ error: expect.any(StoreDeadlineError) });
    });

    test('ends with a deadline it shares, when that passes first, and counts it against the store', async () => {
        const guard = guardOf();
        for (let i = 0; i < 5; i++) {
            const shared = new AbortController();
            const call = outcome(guard.call(0, hang, { signal: shared.signal }));
            await vi.advanceTimersByTimeAsync(1_000);
            shared.abort(new StoreDeadlineError());
            expect(await call).toMatchObject({ error: expect.any(StoreDeadlineError) });
        }
        expect(guard.health()).toBe('open');
    });

    test('five timeouts open the breaker: the sixth call is refused at once and the work is never started', async () => {
        const guard = guardOf();
        for (let i = 0; i < 5; i++) {
            const call = outcome(guard.call(0, hang));
            await vi.advanceTimersByTimeAsync(60_000);
            await call;
        }
        const work = vi.fn(hang);
        const refused = await outcome(guard.call(0, work));
        expect(refused).toMatchObject({ error: expect.any(StoreUnavailableError) });
        expect(refused).toMatchObject({
            error: { storeId: 'store-under-test', code: 'breaker-open' },
        });
        expect(work).not.toHaveBeenCalled();
    });

    test('an error that is the store answering does not open the breaker; one that is not, does', async () => {
        const refusal = Object.assign(new Error('no such key'), { answer: true });
        const guard = guardOf({
            answered: (error) => (error as { answer?: boolean }).answer === true,
        });
        for (let i = 0; i < 20; i++)
            expect(await outcome(guard.call(0, () => Promise.reject(refusal)))).toEqual({
                error: refusal,
            });
        expect(guard.health()).toBe('ok');
        const outage = new Error('connection reset');
        for (let i = 0; i < 5; i++)
            expect(await outcome(guard.call(0, () => Promise.reject(outage)))).toEqual({
                error: outage,
            });
        expect(guard.health()).toBe('open');
    });

    test('after the open minute one trial goes, others are refused meanwhile, and its success closes the breaker', async () => {
        const guard = guardOf();
        for (let i = 0; i < 5; i++)
            await outcome(guard.call(0, () => Promise.reject(new Error('down'))));
        await vi.advanceTimersByTimeAsync(60_000);
        let answer!: (value: string) => void;
        const trial = guard.call(0, () => new Promise<string>((resolve) => (answer = resolve)));
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome(guard.call(0, async () => 'second'))).toMatchObject({
            error: expect.any(StoreUnavailableError),
        });
        answer('trial');
        expect(await trial).toBe('trial');
        expect(await guard.call(0, async () => 'third')).toBe('third');
    });

    test('five successes that each took more than half their deadline mark the store slow, and it is still called', async () => {
        const guard = guardOf();
        const slowly = (ms: number) => () =>
            new Promise<string>((resolve) => setTimeout(() => resolve('done'), ms));
        for (let i = 0; i < 5; i++) {
            const call = guard.call(0, slowly(30_001));
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await call).toBe('done');
        }
        expect(guard.health()).toBe('slow');
        // An upload beginning there still goes.
        expect(await guard.call(0, async () => 'begun')).toBe('begun');
    });

    test('with a cap, never more than the cap in flight, and the time spent waiting for a place is inside the deadline', async () => {
        const guard = guardOf({ cap: 2 });
        let inFlight = 0;
        let most = 0;
        const started: number[] = [];
        const work = (index: number) => async () => {
            started.push(index);
            most = Math.max(most, ++inFlight);
            await new Promise((resolve) => setTimeout(resolve, 25_000));
            inFlight--;
            return index;
        };
        const calls = [0, 1, 2, 3, 4].map((index) => outcome(guard.call(0, work(index))));
        await vi.advanceTimersByTimeAsync(24_999);
        expect(started).toEqual([0, 1]);
        await vi.advanceTimersByTimeAsync(25_001);
        // Fifty seconds in: four done, and the fifth has only now got a place.
        expect(started).toEqual([0, 1, 2, 3, 4]);
        expect(await Promise.all(calls.slice(0, 4))).toEqual([
            { value: 0 },
            { value: 1 },
            { value: 2 },
            { value: 3 },
        ]);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(await Promise.race([calls[4], Promise.resolve('pending')])).toBe('pending');
        // Its 60 seconds began when it was called, not when its turn came: ten seconds of work, and it is over.
        await vi.advanceTimersByTimeAsync(1);
        expect(await calls[4]).toMatchObject({ error: expect.any(StoreDeadlineError) });
        expect(most).toBe(2);
        // The third and fourth waited 25 s and then took 25 s: the wait is not the store being slow.
        expect(guard.health()).toBe('ok');
        expect(guard.inFlight()).toBe(0);
    });
});
