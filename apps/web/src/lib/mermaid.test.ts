import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The diagram worker's client (lib/mermaid.ts). Fails if a diagram's time starts while it waits behind
 * others (valid diagrams time out in a queue), if one diagram that never finishes takes the rest down
 * with it, or if a worker that can't start, or never says it loaded (the first or a replacement), holds
 * the preload or the diagrams waiting on it.
 */

type Message = { kind: 'preload' } | { id: number; source: string };

/* A worker that draws "wait:<ms>" in that many milliseconds, "hang" never, and loads at once. */
class FakeWorker {
    static made = 0;
    static failToStart = false;
    /* Workers after this many fail to load their script (onerror before ready). */
    static loadFailsAfter = Infinity;
    /* Workers after this many never say anything once asked to load (a stalled script). */
    static stallAfter = Infinity;
    static terminated = 0;
    static posted: string[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    private dead = false;

    constructor() {
        if (FakeWorker.failToStart) throw new Error('blocked');
        FakeWorker.made++;
    }

    postMessage(message: Message) {
        if ('kind' in message) {
            if (FakeWorker.made > FakeWorker.stallAfter) return;
            if (FakeWorker.made > FakeWorker.loadFailsAfter) setTimeout(() => this.onerror?.(), 0);
            else setTimeout(() => this.reply({ kind: 'ready' }), 0);
            return;
        }
        FakeWorker.posted.push(message.source);
        if (message.source === 'hang') return;
        const ms = Number(message.source.replace('wait:', ''));
        setTimeout(
            () => this.reply({ id: message.id, outcome: { svg: '<svg/>', width: 1, height: 1 } }),
            ms,
        );
    }

    terminate() {
        if (!this.dead) FakeWorker.terminated++;
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
    FakeWorker.loadFailsAfter = Infinity;
    FakeWorker.stallAfter = Infinity;
    FakeWorker.terminated = 0;
    FakeWorker.posted = [];
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
        const results = ['wait:6000', 'wait:6000', 'wait:6000'].map(
            (source) => mermaid.drawDiagram(source).result,
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
        const stuck = mermaid.drawDiagram('hang').result;
        const after = mermaid.drawDiagram('wait:10').result;
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
        expect(await mermaid.drawDiagram('wait:1').result).toEqual({ failure: 'failed' });
    });

    test('a diagram no longer wanted leaves the queue before it is drawn', async () => {
        const mermaid = await loaded();
        const first = mermaid.drawDiagram('wait:6000');
        const superseded = mermaid.drawDiagram('wait:6001');
        const current = mermaid.drawDiagram('wait:10');
        superseded.cancel();
        await vi.advanceTimersByTimeAsync(6_100);
        expect(await first.result).toEqual({ svg: '<svg/>', width: 1, height: 1 });
        expect(await current.result).toEqual({ svg: '<svg/>', width: 1, height: 1 });
        // The superseded one never reached the worker.
        expect(FakeWorker.posted).toEqual(['wait:6000', 'wait:10']);
    });

    test('a replacement worker that cannot load is not started again', async () => {
        FakeWorker.loadFailsAfter = 1;
        const mermaid = await loaded();
        const stuck = mermaid.drawDiagram('hang').result;
        const after = mermaid.drawDiagram('wait:10').result;
        await vi.advanceTimersByTimeAsync(mermaid.DIAGRAM_TIMEOUT + 1_000);
        expect(await stuck).toEqual({ failure: 'failed' });
        expect(await after).toEqual({ failure: 'failed' });
        await vi.advanceTimersByTimeAsync(60_000);
        // The first, and one replacement that failed to load: no more.
        expect(FakeWorker.made).toBe(2);
        expect(mermaid.diagramsState()).toBe('failed');
    });

    test('a worker that never says it loaded is ended at its deadline, and diagrams say they failed', async () => {
        FakeWorker.stallAfter = 0;
        const mermaid = await import('@/lib/mermaid');
        let done = false;
        void mermaid.preloadMermaid().then(() => {
            done = true;
        });
        // Fences wait on this: it must settle, not hang with the code shown and no sentence.
        let settled = false;
        void mermaid.diagramsSettled.then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(mermaid.STARTUP_TIMEOUT - 100);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(done).toBe(true);
        expect(settled).toBe(true);
        expect(mermaid.diagramsState()).toBe('failed');
        expect(FakeWorker.terminated).toBe(1);
        expect(await mermaid.drawDiagram('wait:1').result).toEqual({ failure: 'failed' });
    });

    test('a replacement worker that stalls is ended too, and the diagrams waiting on it fail', async () => {
        FakeWorker.stallAfter = 1;
        const mermaid = await loaded();
        const stuck = mermaid.drawDiagram('hang').result;
        const waiting = mermaid.drawDiagram('wait:10').result;
        let after: unknown = null;
        void waiting.then((outcome) => {
            after = outcome;
        });
        await vi.advanceTimersByTimeAsync(mermaid.DIAGRAM_TIMEOUT + 100);
        expect(await stuck).toEqual({ failure: 'failed' });
        // The replacement is loading; the waiting diagram waits for it, but not forever.
        expect(after).toBe(null);
        await vi.advanceTimersByTimeAsync(mermaid.STARTUP_TIMEOUT);
        expect(after).toEqual({ failure: 'failed' });
        expect(mermaid.diagramsState()).toBe('failed');
        expect(FakeWorker.made).toBe(2);
        expect(FakeWorker.terminated).toBe(2);
    });

    test('a worker that loaded is not ended when its startup deadline would have passed', async () => {
        const mermaid = await loaded();
        await vi.advanceTimersByTimeAsync(mermaid.STARTUP_TIMEOUT * 2);
        const drawn = mermaid.drawDiagram('wait:10').result;
        await vi.advanceTimersByTimeAsync(20);
        expect(await drawn).toEqual({ svg: '<svg/>', width: 1, height: 1 });
        expect(FakeWorker.terminated).toBe(0);
    });

    test('a Markdown view off the drive starts the bundle, and inside the drive leaves it to the preload', async () => {
        const mermaid = await import('@/lib/mermaid');
        // A public link's page: the first Markdown view starts the worker (once), diagram or not.
        mermaid.startDiagramsForView();
        mermaid.startDiagramsForView();
        expect(FakeWorker.made).toBe(1);

        vi.resetModules();
        FakeWorker.made = 0;
        const owner = await import('@/lib/diagram-owner');
        const inDrive = await import('@/lib/mermaid');
        // The drive's preload has claimed it: a view opened before the preload gets there fetches nothing.
        owner.claimDiagramsForPreload();
        inDrive.startDiagramsForView();
        expect(FakeWorker.made).toBe(0);
    });
});
