/*
 * What a store may do to this process (docs/company-storage-design.md 2.4). A
 * store is a server somebody else runs, and from PR 10 on that somebody may be
 * a company's Owner. Whatever it answers, and however slowly:
 *
 * - a call ends by a total deadline that covers every retry of it;
 * - a store that keeps failing is left alone for a while (the breaker), and one
 *   that keeps answering late is left alone by background work;
 * - a store that is capped has no more than its cap of calls in flight.
 *
 * Nothing here knows S3. `createGuard` is what every call to one store goes
 * through; `storage.ts` puts each S3 request inside it.
 */

export type StoreBounds = {
    /* To connect. */
    connectMs: number;
    /* With no byte moving in either direction. */
    idleMs: number;
    /* The whole call, every retry included, before the allowance for its bytes. */
    callMs: number;
    /* The slowest transfer still waited for: a call is allowed one more second per this many bytes it expects. */
    bytesPerSecond: number;
    /* The most that is read of an answer that is not an object's bytes: a listing, a part list, an error body. */
    answerBytes: number;
    /* Failures or timeouts in a row that open the breaker, and how long it stays open. */
    breakerFailures: number;
    breakerOpenMs: number;
    /* Successes in a row, each slower than half its deadline, that mark the store slow, and for how long. */
    slowCalls: number;
    slowMs: number;
};

/*
 * The design's numbers (2.4), none of them measured:
 * - 10 s to connect: a TCP and TLS handshake to any reachable store takes well
 *   under a second, so ten is a store that is not there;
 * - 30 s idle: longer than any pause a working store makes inside one request;
 * - 60 s for the whole call: room for the SDK's three attempts at a store that
 *   answers, and the longest anyone waits for a call that carries no bytes;
 * - 256 KiB/s: the slowest uplink worth serving, so a 64 MiB part gets 60 s
 *   plus 256 s. `STORAGE_MIN_BYTES_PER_SECOND` lowers it for an honest store
 *   behind a slow link;
 * - 1 MiB of listing: a page of 1,000 keys of ours is about a third of that;
 * - five in a row, 60 s: enough failures not to be one bad request, and a
 *   pause short enough that a store that came back is used again within a
 *   run or two.
 */
export const STORE_BOUNDS: StoreBounds = {
    connectMs: 10_000,
    idleMs: 30_000,
    callMs: 60_000,
    bytesPerSecond: 256 * 1024,
    answerBytes: 1024 * 1024,
    breakerFailures: 5,
    breakerOpenMs: 60_000,
    slowCalls: 5,
    slowMs: 60_000,
};

/* How many calls one company's store may have in flight from each process (2.4). Nothing opens a company's store yet. */
export const COMPANY_STORE_CAP = { worker: 2, web: 4 } as const;

/* The total deadline of one call that expects `expectedBytes` to move. */
export function deadlineFor(
    bounds: Pick<StoreBounds, 'callMs' | 'bytesPerSecond'>,
    expectedBytes = 0,
) {
    return bounds.callMs + Math.ceil((expectedBytes / bounds.bytesPerSecond) * 1000);
}

/*
 * A store this process cannot use now: it cannot be opened here at all, or its
 * breaker is open (`code`). The request fails and no other store is asked
 * instead: signing a URL at the wrong bucket would hand out a dead link, and
 * deleting there would be worse.
 */
export class StoreUnavailableError extends Error {
    readonly code?: 'breaker-open';
    constructor(
        readonly storeId: string,
        why: 'unopenable' | 'breaker-open' = 'unopenable',
    ) {
        super(
            why === 'unopenable'
                ? 'This store cannot be opened by this process.'
                : 'This store is not being called for now.',
        );
        this.name = 'StoreUnavailableError';
        if (why === 'breaker-open') this.code = why;
    }
}

/* A call that did not finish by its total deadline. Never an `AbortError`: that is a client that went away. */
export class StoreDeadlineError extends Error {
    constructor() {
        super('The store did not finish answering in time.');
        this.name = 'StoreDeadlineError';
    }
}

/*
 * An answer that is not what was asked for: more bytes than the range or the
 * limit, fewer, no body, or, of an object to copy, a size that is not the
 * row's or no object at all. The message carries nothing of the store's.
 */
export class StoreAnswerError extends Error {
    constructor(
        readonly code: 'too-long' | 'too-short' | 'size-mismatch' | 'not-found' | 'no-body',
    ) {
        super('The store answered with something other than what was asked for.');
        this.name = 'StoreAnswerError';
    }
}

/*
 * `ok`: call it. `slow`: its calls succeed, late; background work leaves it
 * alone, a person's request still goes. `open`: its breaker is open and every
 * call would be refused at once.
 */
export type Health = 'ok' | 'slow' | 'open';

type Pass = { trial: boolean };

/*
 * The breaker of one store, in this process's memory.
 *
 * Closed, it counts failures in a row; an answer resets the count. At
 * `breakerFailures` it opens for `breakerOpenMs`, and nothing is admitted.
 * After that it is half-open: one call is admitted as the trial, and nothing
 * else until that call ends. The trial's success closes the breaker; its
 * failure opens it again for the full time. A call admitted before the breaker
 * opened and still in flight changes nothing when it ends: only the trial
 * decides.
 *
 * Apart from that it counts successes that took more than half their deadline.
 * `slowCalls` of them in a row mark the store slow for `slowMs`; one success
 * in good time, or a failure, starts the count again. Slow refuses nothing
 * here: it is for whoever asks `health()`.
 */
export function createBreaker(
    bounds: Pick<StoreBounds, 'breakerFailures' | 'breakerOpenMs' | 'slowCalls' | 'slowMs'>,
    now: () => number = Date.now,
) {
    let failures = 0;
    let tripped = false;
    let openUntil = 0;
    let trial = false;
    let slow = 0;
    let slowUntil = 0;

    return {
        /* A pass for one call, or null when the call must be refused. Every pass ends in one of the two below. */
        admit(): Pass | null {
            if (!tripped) return { trial: false };
            if (now() < openUntil || trial) return null;
            trial = true;
            return { trial: true };
        },
        /* The store answered, in `tookMs` of the `allowedMs` the call had. */
        succeeded(pass: Pass, tookMs: number, allowedMs: number) {
            if (tripped) {
                if (!pass.trial) return;
                trial = false;
                tripped = false;
            }
            failures = 0;
            if (tookMs * 2 <= allowedMs) slow = 0;
            else if (++slow >= bounds.slowCalls) {
                slow = 0;
                slowUntil = now() + bounds.slowMs;
            }
        },
        /* The store did not answer, or answered that it is failing. */
        failed(pass: Pass) {
            if (tripped) {
                if (!pass.trial) return;
                trial = false;
                openUntil = now() + bounds.breakerOpenMs;
                return;
            }
            slow = 0;
            if (++failures < bounds.breakerFailures) return;
            failures = 0;
            tripped = true;
            openUntil = now() + bounds.breakerOpenMs;
        },
        health(): Health {
            if (tripped && (now() < openUntil || trial)) return 'open';
            return now() < slowUntil ? 'slow' : 'ok';
        },
    };
}

/*
 * At most `cap` holders at a time; the rest wait in line, first come first
 * served, and one whose signal aborts leaves the line. No cap, no line.
 */
export function createLimiter(cap: number | undefined) {
    let active = 0;
    const line: (() => void)[] = [];
    const releaser = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            // The slot goes straight to whoever is next, so nobody can slip in ahead of the line.
            const next = line.shift();
            if (next) next();
            else active--;
        };
    };
    return {
        async acquire(signal: AbortSignal): Promise<() => void> {
            if (cap === undefined) return () => {};
            if (signal.aborted) throw signal.reason;
            if (active < cap) {
                active++;
                return releaser();
            }
            await new Promise<void>((resolve, reject) => {
                const turn = () => {
                    signal.removeEventListener('abort', gaveUp);
                    resolve();
                };
                const gaveUp = () => {
                    line.splice(line.indexOf(turn), 1);
                    reject(signal.reason);
                };
                signal.addEventListener('abort', gaveUp, { once: true });
                line.push(turn);
            });
            return releaser();
        },
        inFlight: () => active,
        waiting: () => line.length,
    };
}

/* Rejects when `signal` aborts, whatever `work` does then. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        if (signal.aborted) {
            // What `work` does once nobody is waiting for it is nobody's failure.
            work.catch(() => undefined);
            return aborted();
        }
        signal.addEventListener('abort', aborted, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}

/*
 * A signal that aborts with `StoreDeadlineError` after `ms`, or when `outer`
 * aborts, with its reason. `clear` when the work is over.
 */
export function deadline(ms: number, outer?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new StoreDeadlineError()), ms);
    const follow = () => controller.abort(outer!.reason);
    if (outer?.aborted) follow();
    else outer?.addEventListener('abort', follow, { once: true });
    return {
        signal: controller.signal,
        clear() {
            clearTimeout(timer);
            outer?.removeEventListener('abort', follow);
        },
    };
}

export type CallOptions = {
    /* A deadline this call shares with others: when it aborts, so does the call. */
    signal?: AbortSignal;
};

export type Guard = ReturnType<typeof createGuard>;

/*
 * Everything one store's calls go through, in this order:
 *
 * 1. An open breaker refuses the call at once (`StoreUnavailableError`).
 * 2. The deadline starts: `callMs` plus the allowance for the bytes expected.
 *    It covers the wait for a place under the cap and everything `work` does,
 *    and `work` is handed its signal, which it must give to every request it
 *    makes, so a retry is cut off with the attempt before it and none begins
 *    after it. The call ends at the deadline even if `work` ignores the signal.
 * 3. The call waits for a place under the cap, when the store has one.
 * 4. The breaker is asked again, since it may have opened during the wait,
 *    and the outcome is told to it: `answered(error)` says whether an error is
 *    the store answering (it is up, and refused this request) or failing.
 */
export function createGuard(options: {
    storeId: string;
    bounds: StoreBounds;
    cap?: number;
    /* Whether a thrown error is still an answer from the store, not a failure of it. */
    answered: (error: unknown) => boolean;
    now?: () => number;
}) {
    const { storeId, bounds } = options;
    const now = options.now ?? Date.now;
    const breaker = createBreaker(bounds, now);
    const limiter = createLimiter(options.cap);

    async function call<T>(
        expectedBytes: number,
        work: (signal: AbortSignal) => Promise<T>,
        { signal: outer }: CallOptions = {},
    ): Promise<T> {
        if (breaker.health() === 'open') throw new StoreUnavailableError(storeId, 'breaker-open');
        const allowedMs = deadlineFor(bounds, expectedBytes);
        const limit = deadline(allowedMs, outer);
        try {
            const release = await limiter.acquire(limit.signal);
            try {
                const pass = breaker.admit();
                if (!pass) throw new StoreUnavailableError(storeId, 'breaker-open');
                const started = now();
                let result: T;
                try {
                    result = await untilAborted(work(limit.signal), limit.signal);
                } catch (error) {
                    // A deadline that passed is the failure, whatever the cut-off request threw.
                    if (limit.signal.aborted) {
                        breaker.failed(pass);
                        throw limit.signal.reason;
                    }
                    if (options.answered(error))
                        breaker.succeeded(pass, now() - started, allowedMs);
                    else breaker.failed(pass);
                    throw error;
                }
                breaker.succeeded(pass, now() - started, allowedMs);
                return result;
            } finally {
                release();
            }
        } finally {
            limit.clear();
        }
    }

    return {
        storeId,
        bounds,
        call,
        health: () => breaker.health(),
        inFlight: () => limiter.inFlight(),
    };
}
