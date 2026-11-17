import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cancelAllToolRuns } from './active';
import { PlaintextBudget } from './budget';
import {
    RESULT_MAX_BYTES,
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
        const budget = new PlaintextBudget(10);
        const { handle, worker } = run({ budget, onOutput: (o) => void taken.push(o) });
        worker.send(output(0, 6));
        expect(worker.accepted()).toEqual([0]);
        // 12 of 10: the result that crosses the line is taken, the next is not asked for.
        worker.send(output(1, 6));
        expect(worker.accepted()).toEqual([0]);
        // Uploads paused for a minute: waiting on the page, not a hang.
        vi.advanceTimersByTime(60_000);
        expect(handle.getState().status).toBe('running');
        taken[1]!.release();
        expect(worker.accepted()).toEqual([0, 1]);
        // Released twice counts once.
        taken[1]!.release();
        expect(budget.waiting).toBe(6);
        worker.send(output(2, 5));
        expect(worker.accepted()).toEqual([0, 1]);
        taken[0]!.release();
        expect(worker.accepted()).toEqual([0, 1, 2]);
    });

    test('a finished run’s results still count against the next run until released', async () => {
        const budget = new PlaintextBudget(10);
        const taken: ToolOutput[] = [];
        const first = run({ budget, onOutput: (o) => void taken.push(o) }, 'First');
        first.worker.send(output(0, 12));
        first.worker.send({ type: 'done', result: null });
        await first.handle.result;
        expect(budget.waiting).toBe(12);

        const second = run({ budget, onOutput: (o) => void taken.push(o) }, 'Second');
        second.worker.send(output(0, 1));
        expect(second.worker.accepted()).toEqual([]);
        taken[0]!.release();
        expect(second.worker.accepted()).toEqual([0]);

        // The second cancelled: its own result goes back, nothing else.
        second.worker.send(output(1, 3));
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
        taken[0]!.release();
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
