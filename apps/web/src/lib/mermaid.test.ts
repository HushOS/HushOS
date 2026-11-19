import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The diagram worker's client (lib/mermaid.ts). Fails if a diagram's time starts while it waits behind
 * others (valid diagrams time out in a queue), if one diagram that never finishes takes the rest down
 * with it, or if a worker that can't start holds the viewers' preload for its whole wait.
 */

type Message = { kind: 'preload' } | { id: number; source: string };

/* A worker that draws "wait:<ms>" in that many milliseconds, "hang" never, and loads at once. */
class FakeWorker {
    static made = 0;
    static failToStart = false;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    private dead = false;

    constructor() {
        if (FakeWorker.failToStart) throw new Error('blocked');
        FakeWorker.made++;
    }

    postMessage(message: Message) {
        if ('kind' in message) {
            setTimeout(() => this.reply({ kind: 'ready' }), 0);
            return;
        }
        if (message.source === 'hang') return;
        const ms = Number(message.source.replace('wait:', ''));
        setTimeout(
            () => this.reply({ id: message.id, outcome: { svg: '<svg/>', width: 1, height: 1 } }),
            ms,
        );
    }

    terminate() {
        this.dead = true;
    }

    private reply(data: unknown) {
        if (!this.dead) this.onmessage?.({ data } as MessageEvent);
    }
}

async function loaded() {
    const mermaid = await import('@/lib/mermaid');
    const preload = mermaid.preloadMermaid();
    await vi.advanceTimersByTimeAsync(1);
    await preload;
    return mermaid;
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeWorker.made = 0;
    FakeWorker.failToStart = false;
    vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('drawing diagrams in the worker', () => {
    test('each diagram has its whole time from when it is drawn, not from when it was asked', async () => {
        const mermaid = await loaded();
        // Three diagrams of 6 s each: the third starts 12 s after it was asked, and still finishes.
        const results = ['wait:6000', 'wait:6000', 'wait:6000'].map((source) =>
            mermaid.drawDiagram(source),
        );
        await vi.advanceTimersByTimeAsync(18_500);
        expect(await Promise.all(results)).toEqual([
            { svg: '<svg/>', width: 1, height: 1 },
            { svg: '<svg/>', width: 1, height: 1 },
            { svg: '<svg/>', width: 1, height: 1 },
        ]);
        expect(FakeWorker.made).toBe(1);
    });

    test('a diagram that never finishes fails alone, and the rest are drawn in a new worker', async () => {
        const mermaid = await loaded();
        const stuck = mermaid.drawDiagram('hang');
        const after = mermaid.drawDiagram('wait:10');
        await vi.advanceTimersByTimeAsync(mermaid.DIAGRAM_TIMEOUT + 100);
        expect(await stuck).toEqual({ failure: 'failed' });
        expect(await after).toEqual({ svg: '<svg/>', width: 1, height: 1 });
        expect(FakeWorker.made).toBe(2);
    });

    test('a worker that cannot start settles the preload at once, and diagrams say they failed', async () => {
        FakeWorker.failToStart = true;
        const mermaid = await import('@/lib/mermaid');
        let done = false;
        void mermaid.preloadMermaid().then(() => {
            done = true;
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
        expect(mermaid.diagramsState()).toBe('failed');
        expect(await mermaid.drawDiagram('wait:1')).toEqual({ failure: 'failed' });
    });
});
