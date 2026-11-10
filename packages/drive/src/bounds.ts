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
    /* With no byte moving in either direction, on every request but the ones a store answers after working in silence. */
    idleMs: number;
    /* The whole call, every retry included, before the allowance for its bytes. */
    callMs: number;
    /* The slowest transfer still waited for: a call is allowed one more second per this many bytes it expects. */
    bytesPerSecond: number;
    /* The longest any one call is given, whatever its bytes. */
    maxCallMs: number;
    /* The most that is read of an answer that is not an object's bytes: a listing, a part list, an error body. */
    answerBytes: number;
    /* How many of a store's latest calls the breaker looks at, and how old the oldest of them may be. */
    breakerWindow: number;
    breakerWindowMs: number;
    /* Failures among those calls, or in a row whatever their age, that open the breaker, and how long it stays open. */
    breakerFailures: number;
    breakerOpenMs: number;
    /* Calls among them that failed or took more than half their deadline, that mark the store slow, and for how long. */
    slowCalls: number;
    slowMs: number;
};

/*
 * The design's numbers (2.4), none of them measured:
 * - 10 s to connect: a TCP and TLS handshake to any reachable store takes well
 *   under a second, so ten is a store that is not there;
 * - 30 s idle: longer than a working store pauses while bytes are moving. It
 *   does not hold for a request the store answers only after working (a
 *   completion, a rewrite): those are sent without it (`storage.ts`);
 * - 60 s for the whole call: room for the SDK's three attempts at a store that
 *   answers, and the longest anyone waits for a call that carries no bytes;
 * - 256 KiB/s: the slowest uplink worth serving, so a 64 MiB part gets 60 s
 *   plus 256 s. `STORAGE_MIN_BYTES_PER_SECOND` lowers it for an honest store
 *   behind a slow link;
 * - 15 minutes at most for one call: half the 30 minutes a run of a job is
 *   given, so no single call can use a run up, and enough for a 64 MiB part at
 *   the lowest rate the setting accepts (80 KiB/s: 60 s plus 820 s);
 * - 1 MiB of listing: a page of 1,000 keys of ours is about a third of that;
 * - five of the last ten calls, none older than ten minutes: a store that
 *   fails as often as it answers, judged on two runs of the five-minute jobs
 *   and not on yesterday. Five in a row count whatever their age, since five
 *   calls that each wait out a long deadline take longer than that;
 * - 60 s open, 60 s slow: a pause short enough that a store that came back is
 *   used again within a run or two.
 */
export const STORE_BOUNDS: StoreBounds = {
    connectMs: 10_000,
    idleMs: 30_000,
    callMs: 60_000,
    bytesPerSecond: 256 * 1024,
    maxCallMs: 15 * 60_000,
    answerBytes: 1024 * 1024,
    breakerWindow: 10,
    breakerWindowMs: 10 * 60_000,
    breakerFailures: 5,
    breakerOpenMs: 60_000,
    slowCalls: 5,
    slowMs: 60_000,
};

/*
 * The longest a call that a person's request waits on is given: five minutes.
 * S3 says completing a large upload "could take several minutes"; past five no
 * browser or proxy is still waiting, and an upload cut off there is finished by
 * the next try or by the expiry job, which asks the store whether the object is
 * there. The worker's calls have `maxCallMs`.
 */
export const WEB_CALL_MAX_MS = 5 * 60_000;

/* How many calls one company's store may have in flight from each process (2.4). Nothing opens a company's store yet. */
export const COMPANY_STORE_CAP = { worker: 2, web: 4 } as const;

/*
 * The total deadline of one call that expects `expectedBytes` to move: the
 * base and the allowance for the bytes, and never more than the store's
 * ceiling or the caller's own (`maxMs`).
 */
export function deadlineFor(
    bounds: Pick<StoreBounds, 'callMs' | 'bytesPerSecond' | 'maxCallMs'>,
    expectedBytes = 0,
    maxMs = Number.POSITIVE_INFINITY,
) {
    return Math.min(
        bounds.callMs + Math.ceil((expectedBytes / bounds.bytesPerSecond) * 1000),
        bounds.maxCallMs,
        maxMs,
    );
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
 * Closed, it remembers how the store's latest `breakerWindow` calls ended, and
 * forgets one after `breakerWindowMs`. It opens when `breakerFailures` of those
 * failed, or when that many failed in a row whatever their age. So a store
 * that times out four times and answers once, over and over, opens it; a store
 * that fails now and then does not.
 *
 * Open, nothing is admitted for `breakerOpenMs`. After that it is half-open:
 * one call is admitted as the trial, and nothing else until that call ends.
 * The trial's success closes the breaker with nothing remembered; its failure
 * opens it again for the full time. A call admitted before the breaker opened
 * and still in flight changes nothing when it ends: only the trial decides.
 *
 * Slow is the weaker mark, for whoever asks `health()`: it refuses nothing.
 * A store is slow for `slowMs` when `slowCalls` of the calls it remembers
 * went badly, by failing or by taking more than half their deadline, and the
 * latest of them just has. A call that went well never marks it.
 */
export function createBreaker(
    bounds: Pick<
        StoreBounds,
        | 'breakerWindow'
        | 'breakerWindowMs'
        | 'breakerFailures'
        | 'breakerOpenMs'
        | 'slowCalls'
        | 'slowMs'
    >,
    now: () => number = Date.now,
) {
    type Ending = 'failed' | 'slow' | 'well';
    let recent: { at: number; ending: Ending }[] = [];
    let inRow = 0;
    let tripped = false;
    let openUntil = 0;
    let trial = false;
    let slowUntil = 0;

    /* Remembers how a call ended and returns how many remembered calls ended in one of `endings`. */
    function remember(ending: Ending, endings: Ending[]) {
        const oldest = now() - bounds.breakerWindowMs;
        recent = [...recent.filter((call) => call.at >= oldest), { at: now(), ending }].slice(
            -bounds.breakerWindow,
        );
        return recent.filter((call) => endings.includes(call.ending)).length;
    }
    function forget() {
        recent = [];
        inRow = 0;
    }

    return {
        /* A pass for one call, or null when the call must be refused. Every pass ends in exactly one of the three below. */
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
                forget();
            }
            inRow = 0;
            if (tookMs * 2 <= allowedMs) remember('well', []);
            else if (remember('slow', ['slow', 'failed']) >= bounds.slowCalls)
                slowUntil = now() + bounds.slowMs;
        },
        /* The store did not answer, or answered that it is failing. */
        failed(pass: Pass) {
            if (tripped) {
                if (!pass.trial) return;
                trial = false;
                openUntil = now() + bounds.breakerOpenMs;
                return;
            }
            inRow++;
            const bad = remember('failed', ['slow', 'failed']);
            const failures = recent.filter((call) => call.ending === 'failed').length;
            if (inRow >= bounds.breakerFailures || failures >= bounds.breakerFailures) {
                tripped = true;
                openUntil = now() + bounds.breakerOpenMs;
                forget();
            } else if (bad >= bounds.slowCalls) slowUntil = now() + bounds.slowMs;
        },
        /* The call ended without saying anything about the store: its caller's time ran out before the store had its own. */
        released(pass: Pass) {
            if (pass.trial) trial = false;
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

/* The longest delay a timer takes: past it Node and Bun fire after one millisecond instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/*
 * A signal that aborts with `StoreDeadlineError` after `ms`, or when `outer`
 * aborts, with its reason. `clear` when the work is over.
 */
export function deadline(ms: number, outer?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new StoreDeadlineError()),
        Math.min(Math.max(ms, 0), MAX_TIMER_MS),
    );
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
    /* A ceiling on this call's own deadline, below the store's: what a person's request can wait. */
    maxMs?: number;
};

export type Guard = ReturnType<typeof createGuard>;

/*
 * Everything one store's calls go through, in this order:
 *
 * 1. A call whose shared deadline has already passed is not made, and says
 *    nothing about the store. An open breaker refuses the call at once
 *    (`StoreUnavailableError`).
 * 2. The deadline starts: `callMs` plus the allowance for the bytes expected,
 *    up to the ceiling. It covers the wait for a place under the cap and
 *    everything `work` does, and `work` is handed its signal, which it must
 *    give to every request it makes, so a retry is cut off with the attempt
 *    before it and none begins after it. The call ends at the deadline even if
 *    `work` ignores the signal.
 * 3. The call waits for a place under the cap, when the store has one.
 * 4. The breaker is asked again, since it may have opened during the wait,
 *    and the outcome is told to it: `answered(error)` says whether an error is
 *    the store answering (it is up, and refused this request) or failing. A
 *    call ended by the deadline it shares counts against the store only when
 *    the store had more than half of the call's own time and still had not
 *    answered; otherwise the time was spent before this call, and by others.
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
        { signal: outer, maxMs }: CallOptions = {},
    ): Promise<T> {
        if (outer?.aborted) throw outer.reason;
        if (breaker.health() === 'open') throw new StoreUnavailableError(storeId, 'breaker-open');
        const allowedMs = deadlineFor(bounds, expectedBytes, maxMs);
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
                    const tookMs = now() - started;
                    // A deadline that passed is the failure, whatever the cut-off request threw.
                    if (limit.signal.aborted) {
                        if (outer?.aborted && tookMs * 2 <= allowedMs) breaker.released(pass);
                        else breaker.failed(pass);
                        throw limit.signal.reason;
                    }
                    if (options.answered(error)) breaker.succeeded(pass, tookMs, allowedMs);
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
