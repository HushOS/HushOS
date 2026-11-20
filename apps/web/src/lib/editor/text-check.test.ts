import { afterEach, describe, expect, test, vi } from 'vitest';
import { INLINE_CHECK_LIMIT, startCheck } from '@/lib/editor/text-check';

/*
 * The structured-text check never holds the page: a YAML file of many keys
 * takes the parser seconds (60,000 took 11.5 s in a browser), so JSON, YAML and
 * TOML are checked in a worker that a newer edit or a close ends, and where no
 * worker starts only small text is checked on the page.
 */

/* Many distinct keys: valid YAML whose parse grows with the square of its keys. */
const manyKeys = (count: number) =>
    Array.from({ length: count }, (_, i) => `key${i}: value number ${i}`).join('\n') + '\n';

/* A stand-in for the browser's Worker: records what it is sent and whether it was ended. */
class StandInWorker {
    static made: StandInWorker[] = [];
    sent: unknown[] = [];
    terminated = false;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor() {
        StandInWorker.made.push(this);
    }
    postMessage(message: unknown) {
        this.sent.push(message);
    }
    terminate() {
        this.terminated = true;
    }
    answer(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    StandInWorker.made = [];
});

describe('with a worker', () => {
    test('a pathological YAML file goes to the worker; nothing of it is parsed on the page', async () => {
        vi.stubGlobal('Worker', StandInWorker);
        const text = manyKeys(20_000);
        const started = performance.now();
        const check = startCheck('yaml', text);
        const [worker] = StandInWorker.made;
        expect(worker?.sent).toEqual([{ kind: 'yaml', text }]);
        worker?.answer({ failure: null });
        // Answered as soon as the worker answers: nothing of the parse ran here (it takes over a second).
        expect(await check.result).toBeNull();
        expect(performance.now() - started).toBeLessThan(300);
    });

    test('a newer edit or a close ends the worker, and its late answer counts for nothing', async () => {
        vi.stubGlobal('Worker', StandInWorker);
        const check = startCheck('toml', 'a = = 1\n');
        const [worker] = StandInWorker.made;
        check.cancel();
        expect(worker?.terminated).toBe(true);
        worker?.answer({ failure: { line: 1 } });
        expect(await check.result).toBe('skipped');
    });

    test('the worker’s answer is the check’s, and the worker is let go', async () => {
        vi.stubGlobal('Worker', StandInWorker);
        const check = startCheck('json', '{\n  "a": 1,\n}\n');
        const [worker] = StandInWorker.made;
        worker?.answer({ failure: { line: 3 } });
        expect(await check.result).toEqual({ line: 3 });
        expect(worker?.terminated).toBe(true);
    });

    test('a worker that fails to run checks small text on the page, and skips large', async () => {
        vi.stubGlobal('Worker', StandInWorker);
        const small = startCheck('yaml', 'a: 1\na: 2\n');
        StandInWorker.made[0]?.onerror?.(new Event('error'));
        expect(await small.result).toEqual({ line: 2 });
        const large = startCheck('yaml', manyKeys(20_000));
        StandInWorker.made[1]?.onerror?.(new Event('error'));
        expect(await large.result).toBe('skipped');
    });
});

describe('without a worker', () => {
    test('text past the bound is skipped at once, never parsed on the page', async () => {
        vi.stubGlobal('Worker', undefined);
        const text = manyKeys(20_000);
        expect(text.length).toBeGreaterThan(INLINE_CHECK_LIMIT);
        const started = performance.now();
        expect(await startCheck('yaml', text).result).toBe('skipped');
        expect(performance.now() - started).toBeLessThan(100);
    });

    test('small text is still checked', async () => {
        vi.stubGlobal('Worker', undefined);
        expect(await startCheck('yaml', 'a: 1\nb: 2\na: 3\n').result).toEqual({ line: 3 });
        expect(await startCheck('yaml', 'a: 1\n').result).toBeNull();
    });
});
