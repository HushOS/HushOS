import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cancelAllToolRuns } from './active';
import { PlaintextBudget } from './budget';
import {
    OUTPUT_MIN_CHARGE,
    OUTPUTS_UNRELEASED_MAX,
    RESULT_MAX_BYTES,
    RUN_OUTPUTS_MAX,
    TOOL_FAILED,
    type RangeAnswer,
    type ToPage,
    type ToWorker,
} from './protocol';
import { memoryReader, type RangeReader } from './ranges';
import { startToolRun, ToolCancelled, type ToolOutput, type ToolRunOptions } from './run';

/*
 * The page's side of a tool run against a scripted worker: the test speaks for the worker,
 * over the same messages and the same real MessagePorts a tools worker uses, and breaks the
 * rules a worker taken over by a hostile file would. Timers and the clock are faked; port
 * messages are not, so a read really crosses a channel.
 */

class ScriptedWorker {
    onmessage: ((event: MessageEvent<ToPage>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    received: ToWorker[] = [];
    terminated = false;
    refuseStart = false;
    postMessage(message: ToWorker) {
        if (this.refuseStart && message.type === 'start')
            throw new DOMException('could not be cloned', 'DataCloneError');
        if (this.terminated) return;
        this.received.push(message);
    }
    terminate() {
        this.terminated = true;
    }
    /* What the worker sends; nothing reaches the page from a terminated worker. */
    send(message: ToPage) {
        if (this.terminated) return;
        this.onmessage?.({ data: message } as MessageEvent<ToPage>);
    }
    get start() {
        return this.received.find((m) => m.type === 'start') as Extract<
            ToWorker,
            { type: 'start' }
        >;
    }
    accepted() {
        return this.received.flatMap((m) => (m.type === 'accepted' ? [m.id] : []));
    }
}

/* Port messages cross the event loop on their own schedule, which fake timers do not touch. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(condition: () => boolean) {
    for (let i = 0; i < 200 && !condition(); i++) await tick();
    expect(condition()).toBe(true);
}
const ports = async () => {
    for (let i = 0; i < 20; i++) await tick();
};

function run<R = unknown>(
    overrides: Partial<ToolRunOptions<unknown>> = {},
    label = 'Extracting Photos.zip',
    worker = new ScriptedWorker(),
) {
    let made = 0;
    const handle = startToolRun<unknown, R>({
        label,
        worker: () => {
            made++;
            return worker as unknown as Worker;
        },
        input: { tool: 'test' },
        sources: [memoryReader(new Uint8Array([1, 2, 3, 4, 5]))],
        budget: new PlaintextBudget(),
        ...overrides,
    });
    live.push(handle);
    return {
        handle,
        worker,
        get made() {
            return made;
        },
    };
}

/* Whether every buffer `refs` points at is gone after a few full collections. */
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
async function collected(refs: WeakRef<object>[]) {
    for (let i = 0; i < 10; i++) {
        // A WeakRef keeps its target to the end of the job that made it: collect on a later one.
        await tick();
        gc();
        if (refs.every((ref) => ref.deref() === undefined)) return true;
    }
    return false;
}

/* One minimum charge: the budget tests count in these, so every result's size is what it costs. */
const U = OUTPUT_MIN_CHARGE;

const output = (id: number, bytes: number): ToPage => ({
    type: 'output',
    id,
    name: `out-${id}`,
    mime: null,
    bytes: new ArrayBuffer(bytes),
});

/* A source whose reads the test answers. */
function heldReader() {
    const answers: ((bytes: Uint8Array) => void)[] = [];
    let closed = 0;
    const reader: RangeReader = {
        size: 1 << 30,
        read: () => new Promise<Uint8Array>((resolve) => answers.push(resolve)),
        close: () => void closed++,
    };
    return {
        reader,
        answers,
        get closed() {
            return closed;
        },
    };
}

const live: { cancel(): void }[] = [];
beforeEach(() =>
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    }),
);
afterEach(() => {
    // Every run ends, so the next test does not queue behind one left over.
    for (const handle of live.splice(0)) handle.cancel();
    vi.useRealTimers();
});

describe('the watchdog', () => {
    test('stops a worker that reports nothing for 30 seconds', async () => {
        const { handle, worker } = run();
        const failed = expect(handle.result).rejects.toThrow(TOOL_FAILED);
        vi.advanceTimersByTime(20_000);
        worker.send({ type: 'progress', done: 1, total: 10 });
        // Progress started the clock over: 49.999 s in, 29.999 s since.
        vi.advanceTimersByTime(29_999);
        expect(handle.getState().status).toBe('running');
        expect(worker.terminated).toBe(false);
        vi.advanceTimersByTime(1);
        await failed;
        expect(worker.terminated).toBe(true);
        expect(handle.getState()).toEqual({ status: 'failed', message: TOOL_FAILED });
    });

    test('a tab the browser froze for ten minutes counts two seconds of it', () => {
        const { handle } = run();
        // The page's timers don't run while frozen; the clock does.
        vi.setSystemTime(Date.now() + 600_000);
        vi.advanceTimersByTime(1_000);
        expect(handle.getState().status).toBe('running');
        vi.advanceTimersByTime(27_000);
        expect(handle.getState().status).toBe('running');
        vi.advanceTimersByTime(1_000);
        expect(handle.getState()).toEqual({ status: 'failed', message: TOOL_FAILED });
    });

    test('leaves out a read the page is still answering, and does not start over for one', async () => {
        const held = heldReader();
        const { handle, worker } = run({ sources: [held.reader] });
        const port = worker.start.sources[0]!.port;
        const answers: RangeAnswer[] = [];
        port.onmessage = (event) => answers.push(event.data);

        vi.advanceTimersByTime(10_000);
        port.postMessage({ type: 'read', id: 0, offset: 0, length: 10 });
        await until(() => held.answers.length === 1);
        // A slow network: the read takes two minutes, and the run is not hung.
        vi.advanceTimersByTime(120_000);
        expect(handle.getState().status).toBe('running');
        held.answers[0]!(new Uint8Array(10));
        await until(() => answers.length === 1);
        // 10 s before the read, 19.999 s after: still inside 30.
        vi.advanceTimersByTime(19_999);
        expect(handle.getState().status).toBe('running');
        // A parser looping over a cached range: each read answers at once and buys nothing.
        port.postMessage({ type: 'read', id: 1, offset: 0, length: 10 });
        await until(() => held.answers.length === 2);
        held.answers[1]!(new Uint8Array(10));
        await until(() => answers.length === 2);
        expect(handle.getState().status).toBe('running');
        vi.advanceTimersByTime(1);
        expect(handle.getState()).toEqual({ status: 'failed', message: TOOL_FAILED });
        expect(worker.terminated).toBe(true);
    });
});

describe('the produced-plaintext budget', () => {
    test('holds the next result back until uploads drain below the limit, without the watchdog firing', () => {
        const taken: ToolOutput[] = [];
        const budget = new PlaintextBudget(10 * U);
        const { handle, worker } = run({ budget, onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 6 * U));
        expect(worker.accepted()).toEqual([0]);
        // 12 of 10: the result that crosses the line is taken, the next is not asked for.
        worker.send(output(1, 6 * U));
        expect(worker.accepted()).toEqual([0]);
        // Uploads paused for a minute: waiting on the page, not a hang.
        vi.advanceTimersByTime(60_000);
        expect(handle.getState().status).toBe('running');
        taken[1]!.release();
        expect(worker.accepted()).toEqual([0, 1]);
        // Released twice counts once.
        taken[1]!.release();
        expect(budget.waiting).toBe(6 * U);
        worker.send(output(2, 5 * U));
        expect(worker.accepted()).toEqual([0, 1]);
        taken[0]!.release();
        expect(worker.accepted()).toEqual([0, 1, 2]);
    });

    test('a finished run’s results still count against the next run until released', async () => {
        const budget = new PlaintextBudget(10 * U);
        const taken: ToolOutput[] = [];
        const first = run({ budget, onOutput: (o) => void taken.push(o) }, 'First');
        // Accepted (8 of 10), then done: its result waits for upload after the run.
        first.worker.send(output(0, 8 * U));
        expect(first.worker.accepted()).toEqual([0]);
        first.worker.send({ type: 'done', result: null });
        await first.handle.result;
        expect(budget.waiting).toBe(8 * U);

        const second = run({ budget, onOutput: (o) => void taken.push(o) }, 'Second');
        second.worker.send(output(0, 3 * U));
        expect(second.worker.accepted()).toEqual([]);
        taken[0]!.release();
        expect(second.worker.accepted()).toEqual([0]);

        // The second cancelled: its own result goes back, nothing else.
        second.worker.send(output(1, 3 * U));
        second.handle.cancel();
        expect(budget.waiting).toBe(0);
        expect(taken[1]!.bytes.byteLength).toBe(0);
    });

    test('a run without a save path drops each result as it comes, and keeps going', () => {
        const { worker } = run({ budget: new PlaintextBudget(10) });
        worker.send(output(0, 50));
        worker.send(output(1, 50));
        expect(worker.accepted()).toEqual([0, 1]);
    });
});

describe('a worker that does not pace itself fails its run', () => {
    test('a result sent before the last was accepted', async () => {
        const { handle, worker } = run({
            budget: new PlaintextBudget(10),
            onOutput: () => {},
        });
        worker.send(output(0, 20));
        const second = output(1, 5);
        worker.send(second);
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(worker.terminated).toBe(true);
        expect((second as { bytes: ArrayBuffer }).bytes.byteLength).toBe(0);
    });

    test('an id seen before, or one out of turn', async () => {
        const repeated = run({ onOutput: (o) => o.release() });
        repeated.worker.send(output(0, 1));
        repeated.worker.send(output(0, 1));
        await expect(repeated.handle.result).rejects.toThrow(TOOL_FAILED);
        const skipped = run({ onOutput: (o) => o.release() });
        skipped.worker.send(output(3, 1));
        await expect(skipped.handle.result).rejects.toThrow(TOOL_FAILED);
    });

    test('a result larger than one upload can hold', async () => {
        const taken: ToolOutput[] = [];
        const { handle, worker } = run({ onOutput: (o) => void taken.push(o) });
        worker.send(output(0, RESULT_MAX_BYTES + 1));
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(taken).toEqual([]);
    });

    test('a result whose name or type is not a short plain string', async () => {
        const huge = 'x'.repeat(1_025);
        for (const bad of [
            { name: huge, mime: null },
            { name: 'a.txt', mime: 'y'.repeat(256) },
            { name: 7, mime: null },
            { name: 'a.txt', mime: { type: 'text/plain' } },
        ]) {
            const taken: ToolOutput[] = [];
            const { handle, worker } = run({ onOutput: (o) => void taken.push(o) });
            worker.send({
                type: 'output',
                id: 0,
                bytes: new ArrayBuffer(0),
                ...bad,
            } as unknown as ToPage);
            await expect(handle.result).rejects.toThrow(TOOL_FAILED);
            expect(taken).toEqual([]);
        }
        // At the limits, fine.
        const fine = run({ onOutput: (o) => o.release() });
        fine.worker.send({
            type: 'output',
            id: 0,
            name: 'n'.repeat(1_024),
            mime: 'm'.repeat(255),
            bytes: new ArrayBuffer(1),
        });
        expect(fine.worker.accepted()).toEqual([0]);
    });

    test('nothing the page keeps reaches anything else a worker’s message carried', async () => {
        const taken: ToolOutput[] = [];
        const { worker } = run({ onOutput: (o) => void taken.push(o) });
        const refs: WeakRef<ArrayBuffer>[] = [];
        const extra = () => {
            const buffer = new ArrayBuffer(16 * 1024 * 1024);
            refs.push(new WeakRef(buffer));
            return buffer;
        };
        worker.send({ ...output(0, 8), extra: extra() } as unknown as ToPage);
        worker.send({ type: 'progress', done: 1, total: 2, extra: extra() } as unknown as ToPage);
        expect(worker.accepted()).toEqual([0]);
        expect(Object.keys(taken[0]!).sort()).toEqual(['bytes', 'mime', 'name', 'release', 'size']);
        // Still held by the save path, then a lock: neither keeps the extra buffers.
        expect(await collected(refs)).toBe(true);
        cancelAllToolRuns();
        expect(taken[0]!.bytes.byteLength).toBe(0);
        taken[0]!.release();
    });

    test('empty results cost the budget too, and a run holds at most 10,000 unreleased', async () => {
        const budget = new PlaintextBudget(16 * U);
        const taken: ToolOutput[] = [];
        const { worker } = run({ budget, onOutput: (o) => void taken.push(o) });
        for (let id = 0; id < 20 && worker.accepted().length === id; id++)
            worker.send(output(id, 0));
        // Sixteen empty results fill a budget of sixteen charges: the next is not asked for.
        expect(worker.accepted()).toHaveLength(15);
        expect(taken).toHaveLength(16);
        expect(budget.waiting).toBe(16 * U);
        taken[0]!.release();
        expect(worker.accepted()).toHaveLength(16);
        cancelAllToolRuns();
        expect(budget.waiting).toBe(0);

        // With room to spare, the count still stops the run at the cap, without the watchdog firing.
        const roomy = new PlaintextBudget(Number.MAX_SAFE_INTEGER);
        const held: ToolOutput[] = [];
        const capped = run(
            // A total cap past the unreleased one, so only the latter is tested here.
            {
                budget: roomy,
                maxOutputs: OUTPUTS_UNRELEASED_MAX + 2,
                onOutput: (o) => void held.push(o),
            },
            'Capped',
        );
        for (let id = 0; id < OUTPUTS_UNRELEASED_MAX; id++) capped.worker.send(output(id, 0));
        expect(held).toHaveLength(OUTPUTS_UNRELEASED_MAX);
        expect(capped.worker.accepted()).toHaveLength(OUTPUTS_UNRELEASED_MAX - 1);
        vi.advanceTimersByTime(60_000);
        expect(capped.handle.getState().status).toBe('running');
        held[5]!.release();
        expect(capped.worker.accepted()).toHaveLength(OUTPUTS_UNRELEASED_MAX);
        capped.worker.send(output(OUTPUTS_UNRELEASED_MAX, 0));
        expect(capped.worker.accepted()).toHaveLength(OUTPUTS_UNRELEASED_MAX);
        held[6]!.release();
        expect(capped.worker.accepted()).toHaveLength(OUTPUTS_UNRELEASED_MAX + 1);
    });

    test('more results, or more bytes, than the run may produce in all', async () => {
        const counted = run({ maxOutputs: 2 });
        counted.worker.send(output(0, 1));
        counted.worker.send(output(1, 1));
        expect(counted.worker.accepted()).toEqual([0, 1]);
        const third = output(2, 1);
        counted.worker.send(third);
        await expect(counted.handle.result).rejects.toThrow(TOOL_FAILED);
        expect((third as { bytes: ArrayBuffer }).bytes.byteLength).toBe(0);

        // Released as they go, still counted: bytes in all, not bytes held.
        const sized = run({ maxTotalBytes: 10 });
        sized.worker.send(output(0, 6));
        sized.worker.send(output(1, 4));
        expect(sized.worker.accepted()).toEqual([0, 1]);
        sized.worker.send(output(2, 1));
        await expect(sized.handle.result).rejects.toThrow(TOOL_FAILED);

        // A cap that is not a positive whole number is the caller's bug: it throws, before any worker.
        let made = 0;
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5]) {
            for (const cap of ['maxOutputs', 'maxTotalBytes'] as const) {
                expect(() =>
                    startToolRun({
                        label: 'Bad cap',
                        worker: () => {
                            made++;
                            return new ScriptedWorker() as unknown as Worker;
                        },
                        input: null,
                        sources: [],
                        budget: new PlaintextBudget(),
                        [cap]: bad,
                    }),
                ).toThrow(RangeError);
            }
        }
        expect(made).toBe(0);

        // Without a cap of its own, a run gets section 3's.
        const plain = run({ budget: new PlaintextBudget(Number.MAX_SAFE_INTEGER) });
        for (let id = 0; id < RUN_OUTPUTS_MAX; id++) plain.worker.send(output(id, 0));
        expect(plain.worker.accepted()).toHaveLength(RUN_OUTPUTS_MAX);
        plain.worker.send(output(RUN_OUTPUTS_MAX, 0));
        await expect(plain.handle.result).rejects.toThrow(TOOL_FAILED);
    });

    test('more reads in flight than the page allows', async () => {
        const held = heldReader();
        const { handle, worker } = run({ sources: [held.reader] });
        const port = worker.start.sources[0]!.port;
        port.onmessage = () => {};
        port.postMessage({ type: 'read', id: 0, offset: 0, length: 10 });
        port.postMessage({ type: 'read', id: 1, offset: 10, length: 10 });
        await until(() => held.answers.length === 2);
        expect(handle.getState().status).toBe('running');
        port.postMessage({ type: 'read', id: 2, offset: 20, length: 10 });
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(held.answers).toHaveLength(2);
    });

    test('reads past 64 MiB in flight together', async () => {
        const held = heldReader();
        const { handle, worker } = run({ sources: [held.reader] });
        const port = worker.start.sources[0]!.port;
        port.onmessage = () => {};
        port.postMessage({ type: 'read', id: 0, offset: 0, length: 40 * 1024 * 1024 });
        port.postMessage({ type: 'read', id: 1, offset: 0, length: 40 * 1024 * 1024 });
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(held.answers).toHaveLength(1);
    });
});

describe('ending a run', () => {
    test('cancel terminates the worker, detaches every unreleased result and revokes the run’s URLs', async () => {
        const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run-1');
        const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const taken: ToolOutput[] = [];
        const { handle, worker } = run({ onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 1024));
        worker.send(output(1, 2048));
        taken[0]!.release();
        const url = handle.objectUrl(new Blob(['preview']), 'image');
        expect(created).toHaveBeenCalledTimes(1);

        handle.cancel();
        await expect(handle.result).rejects.toBeInstanceOf(ToolCancelled);
        expect(worker.terminated).toBe(true);
        expect(handle.getState()).toEqual({ status: 'cancelled' });
        // The save path still holds the object, but its bytes are gone.
        expect(taken[1]!.bytes.byteLength).toBe(0);
        // Released before the cancel: the upload has it, and the run leaves it alone.
        expect(taken[0]!.bytes.byteLength).toBe(1024);
        expect(revoked).toHaveBeenCalledWith(url);
        // A source port is closed: a late read gets no answer.
        const port = worker.start.sources[0]!.port;
        const answers: unknown[] = [];
        port.onmessage = (event) => answers.push(event.data);
        port.postMessage({ type: 'read', id: 9, offset: 0, length: 1 });
        await ports();
        expect(answers).toEqual([]);
    });

    test('a run that ended, done or cancelled, holds none of its input through its handle', async () => {
        const refs: WeakRef<ArrayBuffer>[] = [];
        const taken: ToolOutput[] = [];
        // Made where the test keeps no reference: only the run could hold the bytes.
        const start = () => {
            const bytes = new Uint8Array(16 * 1024 * 1024);
            refs.push(new WeakRef(bytes.buffer));
            return run({ sources: [memoryReader(bytes)], onOutput: (o) => void taken.push(o) });
        };
        // And a reader with no close() at all: the run itself lets go of it.
        const unclosable = (() => {
            const bytes = new Uint8Array(16 * 1024 * 1024);
            refs.push(new WeakRef(bytes.buffer));
            const reader: RangeReader = { size: bytes.byteLength, read: async () => bytes };
            return run({ sources: [reader] });
        })();
        unclosable.handle.cancel();
        const cancelled = start();
        cancelled.handle.cancel();
        await expect(cancelled.handle.result).rejects.toThrow(ToolCancelled);
        // Done with a result the save path still holds: its release() keeps the run's scope.
        const done = start();
        done.worker.send(output(0, 8));
        done.worker.send({ type: 'done', result: null });
        await done.handle.result;
        expect(await collected(refs)).toBe(true);
        expect(cancelled.handle.getState().status).toBe('cancelled');
        expect(unclosable.handle.getState().status).toBe('cancelled');
        expect(done.handle.getState().status).toBe('done');
        taken[0]!.release();
    });

    test('every run closes its sources, and a read that lands after the end is not copied', async () => {
        const held = heldReader();
        const { handle, worker } = run({ sources: [held.reader] });
        worker.start.sources[0]!.port.postMessage({ type: 'read', id: 0, offset: 0, length: 4 });
        await until(() => held.answers.length === 1);
        handle.cancel();
        await until(() => held.closed === 1);
        // The source answers late: the bytes are never sliced into a copy.
        const late = new Uint8Array(4);
        const slice = vi.spyOn(late, 'slice');
        held.answers[0]!(late);
        await ports();
        expect(slice).not.toHaveBeenCalled();

        const done = heldReader();
        const finished = run({ sources: [done.reader] });
        finished.worker.send({ type: 'done', result: 1 });
        await finished.handle.result;
        await until(() => done.closed === 1);
    });

    test('a reader whose bytes are its own hands them over without a copy', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const reader: RangeReader = { size: 3, fresh: true, read: async () => bytes };
        const { worker } = run({ sources: [reader] });
        const port = worker.start.sources[0]!.port;
        const answers: RangeAnswer[] = [];
        port.onmessage = (event) => answers.push(event.data);
        port.postMessage({ type: 'read', id: 0, offset: 0, length: 3 });
        await until(() => answers.length === 1);
        // Moved: the reader's buffer is now the worker's.
        expect(bytes.byteLength).toBe(0);
    });

    test('a lock or sign-out ends every run, running or waiting', async () => {
        const running = run({}, 'Running');
        const waiting = run({}, 'Waiting');
        expect(waiting.handle.getState().status).toBe('waiting');
        cancelAllToolRuns();
        await expect(running.handle.result).rejects.toBeInstanceOf(ToolCancelled);
        await expect(waiting.handle.result).rejects.toBeInstanceOf(ToolCancelled);
        expect(running.worker.terminated).toBe(true);
        expect(waiting.made).toBe(0);
    });

    test('a result is a plain summary; bytes in it fail the run', async () => {
        const fine = run();
        fine.worker.send({ type: 'done', result: { files: 3, names: ['a.txt'], skipped: null } });
        await expect(fine.handle.result).resolves.toEqual({
            files: 3,
            names: ['a.txt'],
            skipped: null,
        });
        // A worker taken over hands plaintext back as the result instead of as an output.
        for (const result of [
            new ArrayBuffer(16),
            { data: new Uint8Array(16) },
            [new Blob(['secret'])],
            new Map([['a', 1]]),
            'x'.repeat(65 * 1024),
        ]) {
            const bad = run();
            bad.worker.send({ type: 'done', result });
            await expect(bad.handle.result).rejects.toThrow(TOOL_FAILED);
            expect(bad.worker.terminated).toBe(true);
        }
    });

    test('a result built to hold the page’s thread fails fast', async () => {
        // A shared reference nested 30 deep: a billion paths through it, and tiny as a message.
        let shared: unknown = [];
        for (let i = 0; i < 30; i++) shared = [shared, shared];
        // A sparse array as long as an array can be.
        const sparse: unknown[] = [];
        sparse.length = 2 ** 32 - 1;
        // Twelve thousand small values, each fine alone.
        const many = Array.from({ length: 4_000 }, () => [1, 2, 3]);
        for (const result of [shared, sparse, many, { a: shared }]) {
            const started = performance.now();
            const bad = run();
            bad.worker.send({ type: 'done', result });
            await expect(bad.handle.result).rejects.toThrow(TOOL_FAILED);
            expect(performance.now() - started).toBeLessThan(500);
        }
    });

    test('the result is rebuilt on the page, plain data only: nothing else of the worker’s is kept', async () => {
        // Bytes anywhere reachable: named properties, symbol keys, anything.
        const reachesBytes = (value: unknown, seen = new Set<unknown>()): boolean => {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
            if (typeof value !== 'object' || value === null || seen.has(value)) return false;
            seen.add(value);
            return Reflect.ownKeys(value).some((key) =>
                reachesBytes((value as Record<PropertyKey, unknown>)[key], seen),
            );
        };
        const named = Object.assign([1, 2], { payload: new ArrayBuffer(8) });
        const symbol = { a: 1, [Symbol('payload')]: new ArrayBuffer(8) };
        const sent = { list: named, other: symbol, ['__proto__']: { kept: 'as a key' } };
        const done = run();
        done.worker.send({ type: 'done', result: sent });
        const value = await done.handle.result;
        expect(value).not.toBe(sent);
        expect(JSON.parse(JSON.stringify(value))).toEqual({
            list: [1, 2],
            other: { a: 1 },
            ['__proto__']: { kept: 'as a key' },
        });
        expect(reachesBytes(value)).toBe(false);
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        cancelAllToolRuns();
        expect(reachesBytes(value)).toBe(false);

        // What only reads bytes when looked at, or isn't plain at all: the run fails.
        class Report {
            files = 1;
        }
        for (const result of [
            {
                get data() {
                    return new ArrayBuffer(8);
                },
            },
            new Report(),
            new Proxy(
                {},
                {
                    ownKeys: () => ['data'],
                    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
                    get: () => new ArrayBuffer(8),
                },
            ),
            new Proxy(
                {},
                {
                    ownKeys: () => {
                        throw new Error('a trap');
                    },
                },
            ),
        ]) {
            const bad = run();
            bad.worker.send({ type: 'done', result });
            await expect(bad.handle.result).rejects.toThrow(TOOL_FAILED);
        }
    });

    test('done while a result still waits for room fails the run, so runs can’t stack past the budget', async () => {
        const budget = new PlaintextBudget(10);
        const taken: ToolOutput[] = [];
        for (let i = 0; i < 5; i++) {
            const r = run({ budget, onOutput: (o) => void taken.push(o) }, `Run ${i}`);
            // Over the line, so not accepted; then it says it is done anyway.
            r.worker.send(output(0, 20));
            expect(r.worker.accepted()).toEqual([]);
            r.worker.send({ type: 'done', result: null });
            await expect(r.handle.result).rejects.toThrow(TOOL_FAILED);
        }
        expect(budget.waiting).toBe(0);
        expect(taken.every((o) => o.bytes.byteLength === 0)).toBe(true);
    });

    test('a refusal is shown in the page’s words, never the worker’s', async () => {
        const refusals = { password: 'This PDF has a password.' };
        const known = run({ refusals });
        known.worker.send({ type: 'fail', code: 'password' });
        await expect(known.handle.result).rejects.toThrow('This PDF has a password.');
        // A worker taken over says whatever it likes: it is not shown.
        const unknown = run({ refusals });
        unknown.worker.send({ type: 'fail', code: 'Your account is locked. Call 555-0100.' });
        await expect(unknown.handle.result).rejects.toThrow(TOOL_FAILED);
        const inherited = run({ refusals });
        inherited.worker.send({ type: 'fail', code: 'toString' });
        await expect(inherited.handle.result).rejects.toThrow(TOOL_FAILED);
    });

    test('a URL made after the run failed is revoked at once; one too large is refused', () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
        const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const { handle, worker } = run();
        expect(() =>
            handle.objectUrl(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]), 'text'),
        ).toThrow();
        worker.send({ type: 'fail', code: null });
        handle.objectUrl(new Blob(['x']), 'text');
        expect(revoked).toHaveBeenCalledWith('blob:late');
    });

    test('a finished run keeps its results with the save path until a lock or sign-out drops them', async () => {
        const budget = new PlaintextBudget();
        const taken: ToolOutput[] = [];
        const { handle, worker } = run({ budget, onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 100));
        worker.send(output(1, 50));
        worker.send({ type: 'done', result: { files: 2 } });
        await expect(handle.result).resolves.toEqual({ files: 2 });
        expect(worker.terminated).toBe(true);
        // A cancel after done changes nothing: the results are the save path's.
        handle.cancel();
        expect(handle.getState()).toEqual({ status: 'done' });
        expect(taken[0]!.bytes.byteLength).toBe(100);
        taken[0]!.release();
        // Each result costs the budget at least OUTPUT_MIN_CHARGE.
        expect(budget.waiting).toBe(U);

        // Then the tab locks, before the second result was uploaded.
        cancelAllToolRuns();
        expect(taken[1]!.bytes.byteLength).toBe(0);
        expect(budget.waiting).toBe(0);
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        // The save path's late release takes nothing more.
        taken[1]!.release();
        expect(budget.waiting).toBe(0);
    });

    test('while a result waits for upload, leaving the page asks first', () => {
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };
        expect(unload()).toBe(false);
        const taken: ToolOutput[] = [];
        const { worker } = run({ onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 10));
        expect(unload()).toBe(true);
        taken[0]!.release();
        expect(unload()).toBe(false);
    });

    test('a worker that fails to load or throws outside the tool fails the run', async () => {
        const { handle, worker } = run();
        worker.onerror?.(new ErrorEvent('error'));
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(worker.terminated).toBe(true);
    });

    test('a worker that cannot be made fails its run and lets the next start', async () => {
        const { handle } = run({
            worker: () => {
                throw new DOMException('Refused', 'SecurityError');
            },
        });
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        const next = run({}, 'After');
        expect(next.made).toBe(1);
    });
});

describe('one run at a time', () => {
    test('a second run waits behind the first, without a worker, and starts when it ends', async () => {
        const first = run({}, 'Extracting Photos.zip');
        const second = run({}, 'Converting 3 photos');
        const third = run({}, 'Compressing 2 items');
        expect(second.made).toBe(0);
        expect(second.handle.getState()).toEqual({
            status: 'waiting',
            behind: 'Extracting Photos.zip',
        });
        // A waiting run cancelled never starts.
        third.handle.cancel();
        await expect(third.handle.result).rejects.toBeInstanceOf(ToolCancelled);

        first.worker.send({ type: 'done', result: null });
        await first.handle.result;
        expect(second.made).toBe(1);
        expect(second.handle.getState().status).toBe('running');
        expect(third.made).toBe(0);

        second.worker.send({ type: 'fail', code: null });
        await expect(second.handle.result).rejects.toThrow();
        // Nothing left running: the next starts at once.
        const fourth = run({}, 'Extracting Site.zip');
        expect(fourth.made).toBe(1);
        expect(fourth.handle.getState().status).toBe('running');
    });

    test('a run waiting behind two learns the second’s name when the first ends', () => {
        const first = run({}, 'A');
        const second = run({}, 'B');
        const third = run({}, 'C');
        expect(third.handle.getState()).toEqual({ status: 'waiting', behind: 'A' });
        first.handle.cancel();
        expect(second.handle.getState().status).toBe('running');
        expect(third.handle.getState()).toEqual({ status: 'waiting', behind: 'B' });
    });

    test('a run cancelled by a listener as it is let in starts no worker', async () => {
        const first = run({}, 'First');
        const second = run({}, 'Second');
        second.handle.subscribe((state) => {
            if (state.status === 'running') cancelAllToolRuns();
        });
        first.worker.send({ type: 'done', result: null });
        await first.handle.result;
        await expect(second.handle.result).rejects.toBeInstanceOf(ToolCancelled);
        expect(second.made).toBe(0);
        expect(second.handle.getState()).toEqual({ status: 'cancelled' });
    });

    test('a listener that cancels the run ahead of it as the queue moves starts it once', async () => {
        const a = run({}, 'A');
        const b = run({}, 'B');
        const c = run({}, 'C');
        // When A ends, C is told it now waits behind B, and cancels B there.
        c.handle.subscribe((state) => {
            if (state.status === 'waiting' && state.behind === 'B') b.handle.cancel();
        });
        a.worker.send({ type: 'done', result: null });
        await a.handle.result;
        await expect(b.handle.result).rejects.toBeInstanceOf(ToolCancelled);
        expect(b.made).toBe(0);
        expect(c.made).toBe(1);
        expect(c.worker.received.filter((m) => m.type === 'start')).toHaveLength(1);
        c.handle.cancel();
        expect(c.worker.terminated).toBe(true);
    });

    test('a viewer’s look starts beside a run, never holds the slot, and may produce nothing', async () => {
        const first = run({}, 'Extracting Photos.zip');
        const look = run({ viewer: true }, 'Reading 2 PDFs');
        // Started at once, though a run is going.
        expect(look.made).toBe(1);
        expect(look.handle.getState().status).toBe('running');
        // A run asked for meanwhile waits behind the run, never behind the look.
        const second = run({}, 'Converting 3 photos');
        expect(second.handle.getState()).toEqual({
            status: 'waiting',
            behind: 'Extracting Photos.zip',
        });
        look.worker.send({ type: 'done', result: { pages: 3 } });
        await expect(look.handle.result).resolves.toEqual({ pages: 3 });
        // Its end lets nothing in: the run still holds the slot.
        expect(second.made).toBe(0);
        first.handle.cancel();
        expect(second.made).toBe(1);
        // A result from a look fails it, its bytes dropped.
        const greedy = run({ viewer: true, onOutput: () => {} }, 'Reading 1 PDF');
        const bytes = new ArrayBuffer(16);
        greedy.worker.send({ type: 'output', id: 0, name: 'x', mime: null, bytes });
        await expect(greedy.handle.result).rejects.toThrow(TOOL_FAILED);
        expect(bytes.byteLength).toBe(0);
        expect(greedy.worker.terminated).toBe(true);
    });

    test('a run that ends settles first, whatever the next does when it starts', async () => {
        const first = run({}, 'First');
        // A listener that throws, and a next run whose input can't be sent.
        first.handle.subscribe(() => {
            throw new Error('a careless listener');
        });
        const broken = new ScriptedWorker();
        broken.refuseStart = true;
        const second = run({}, 'Second', broken);
        first.worker.send({ type: 'done', result: 'first' });
        await expect(first.handle.result).resolves.toBe('first');
        await expect(second.handle.result).rejects.toThrow(TOOL_FAILED);
        const third = run({}, 'Third');
        expect(third.handle.getState().status).toBe('running');
    });
});
