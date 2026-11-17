import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TOOL_FAILED, type RangeAnswer, type ToPage, type ToWorker } from './protocol';
import { memoryReader } from './ranges';
import { startToolRun, ToolCancelled, type ToolOutput, type ToolRunOptions } from './run';

/*
 * The page's side of a tool run against a scripted worker: the test speaks for the worker,
 * over the same messages and the same real MessagePorts a tools worker uses. Timers and the
 * clock are faked; port messages are not, so a read really crosses a channel.
 */

class ScriptedWorker {
    onmessage: ((event: MessageEvent<ToPage>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    received: ToWorker[] = [];
    terminated = false;
    postMessage(message: ToWorker) {
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
) {
    const worker = new ScriptedWorker();
    let made = 0;
    const handle = startToolRun<unknown, R>({
        label,
        worker: () => {
            made++;
            return worker as unknown as Worker;
        },
        input: { tool: 'test' },
        sources: [memoryReader(new Uint8Array([1, 2, 3, 4, 5]))],
        ...overrides,
    });
    return {
        handle,
        worker,
        get made() {
            return made;
        },
    };
}

const output = (id: number, bytes: number): ToPage => ({
    type: 'output',
    id,
    name: `out-${id}`,
    mime: null,
    bytes: new ArrayBuffer(bytes),
});

const live: { cancel(): void }[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => {
    // Every run ends, so the next test does not queue behind one left over.
    for (const handle of live.splice(0)) handle.cancel();
    vi.useRealTimers();
});
function track<T extends { handle: { cancel(): void } }>(r: T) {
    live.push(r.handle);
    return r;
}

describe('the watchdog', () => {
    test('stops a worker that reports nothing for 30 seconds', async () => {
        const { handle, worker } = track(run());
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

    test('leaves out a read the page is still answering, and does not start over for one', async () => {
        let answer: (bytes: Uint8Array) => void = () => {};
        let reads = 0;
        const reader = {
            size: 100,
            read: () => {
                reads++;
                return new Promise<Uint8Array>((resolve) => (answer = resolve));
            },
        };
        const { handle, worker } = track(run({ sources: [reader] }));
        const port = worker.start.sources[0]!.port;
        const answers: RangeAnswer[] = [];
        port.onmessage = (event) => answers.push(event.data);

        vi.advanceTimersByTime(10_000);
        port.postMessage({ type: 'read', id: 0, offset: 0, length: 10 });
        await until(() => reads === 1);
        // A slow network: the read takes two minutes, and the run is not hung.
        vi.advanceTimersByTime(120_000);
        expect(handle.getState().status).toBe('running');
        answer(new Uint8Array(10));
        await until(() => answers.length === 1);
        // 10 s before the read, 19.999 s after: still inside 30.
        vi.advanceTimersByTime(19_999);
        expect(handle.getState().status).toBe('running');
        // A parser looping over a cached range: each read answers at once and buys nothing.
        port.postMessage({ type: 'read', id: 1, offset: 0, length: 10 });
        await until(() => reads === 2);
        answer(new Uint8Array(10));
        await until(() => answers.length === 2);
        expect(handle.getState().status).toBe('running');
        vi.advanceTimersByTime(1);
        expect(handle.getState()).toEqual({ status: 'failed', message: TOOL_FAILED });
        expect(worker.terminated).toBe(true);
    });
});

describe('the produced-plaintext budget', () => {
    test('holds the next result back until uploads drain below the limit, without the watchdog firing', async () => {
        const taken: ToolOutput[] = [];
        const { handle, worker } = track(
            run({ budgetBytes: 10, onOutput: (o) => void taken.push(o) }),
        );
        worker.send(output(0, 6));
        expect(worker.accepted()).toEqual([0]);
        // 12 of 10: the result that crosses the line is taken, the next is not asked for.
        worker.send(output(1, 6));
        expect(worker.accepted()).toEqual([0]);
        // Uploads paused for a minute: waiting on the page, not a hang.
        vi.advanceTimersByTime(60_000);
        expect(handle.getState().status).toBe('running');
        taken[1]!.release();
        await Promise.resolve();
        expect(worker.accepted()).toEqual([0, 1]);
        // Released twice counts once.
        taken[1]!.release();
        worker.send(output(2, 5));
        expect(worker.accepted()).toEqual([0, 1]);
        taken[0]!.release();
        await Promise.resolve();
        expect(worker.accepted()).toEqual([0, 1, 2]);
    });

    test('a run without a save path drops each result as it comes, and keeps going', () => {
        const { worker } = track(run({ budgetBytes: 10 }));
        worker.send(output(0, 50));
        worker.send(output(1, 50));
        expect(worker.accepted()).toEqual([0, 1]);
    });
});

describe('cancel', () => {
    test('terminates the worker, detaches every unreleased result and revokes the run’s URLs', async () => {
        const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run-1');
        const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const taken: ToolOutput[] = [];
        const { handle, worker } = run({ onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 1024));
        worker.send(output(1, 2048));
        taken[0]!.release();
        const url = handle.objectUrl(new Blob(['preview']));
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

    test('a URL made after the run failed is revoked at once', () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
        const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const { handle, worker } = run();
        worker.send({ type: 'fail', message: 'This archive is damaged.' });
        handle.objectUrl(new Blob(['x']));
        expect(revoked).toHaveBeenCalledWith('blob:late');
        expect(handle.getState()).toEqual({
            status: 'failed',
            message: 'This archive is damaged.',
        });
    });

    test('a finished run keeps its results with the save path', async () => {
        const taken: ToolOutput[] = [];
        const { handle, worker } = run({ onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 100));
        worker.send({ type: 'done', result: { files: 1 } });
        await expect(handle.result).resolves.toEqual({ files: 1 });
        expect(worker.terminated).toBe(true);
        handle.cancel();
        expect(handle.getState()).toEqual({ status: 'done' });
        expect(taken[0]!.bytes.byteLength).toBe(100);
    });

    test('a worker that fails to load or throws outside the tool fails the run', async () => {
        const { handle, worker } = run();
        worker.onerror?.(new ErrorEvent('error'));
        await expect(handle.result).rejects.toThrow(TOOL_FAILED);
        expect(worker.terminated).toBe(true);
    });
});

test('a worker that cannot be made fails its run and lets the next start', async () => {
    const handle = startToolRun({
        label: 'Broken',
        worker: () => {
            throw new DOMException('Refused', 'SecurityError');
        },
        input: null,
        sources: [],
    });
    await expect(handle.result).rejects.toThrow(TOOL_FAILED);
    const next = track(run({}, 'After'));
    expect(next.made).toBe(1);
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

        second.worker.send({ type: 'fail', message: TOOL_FAILED });
        await expect(second.handle.result).rejects.toThrow();
        // Nothing left running: the next starts at once.
        const fourth = track(run({}, 'Extracting Site.zip'));
        expect(fourth.made).toBe(1);
        expect(fourth.handle.getState().status).toBe('running');
    });

    test('a run waiting behind two learns the second’s name when the first ends', () => {
        const first = run({}, 'A');
        const second = track(run({}, 'B'));
        const third = track(run({}, 'C'));
        expect(third.handle.getState()).toEqual({ status: 'waiting', behind: 'A' });
        first.handle.cancel();
        expect(second.handle.getState().status).toBe('running');
        expect(third.handle.getState()).toEqual({ status: 'waiting', behind: 'B' });
    });
});
