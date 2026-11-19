import { describe, expect, test } from 'vitest';
import { frameThrottle } from '@/lib/frame-throttle';

/*
 * The editor's preview follows typing through this throttle. Fails if the preview waits for typing
 * to stop (a debounce: nothing shown while keys keep coming), if it renders more than once a frame
 * (typing stalls), or if the last keystroke is never shown.
 */

/* Frames that come only when the test says so. */
function manualFrames() {
    let next = 1;
    const queued = new Map<number, () => void>();
    return {
        frames: {
            request: (callback: () => void) => {
                queued.set(next, callback);
                return next++;
            },
            cancel: (id: number) => void queued.delete(id),
        },
        /* One frame: what was waiting for it runs. */
        frame: () => {
            const due = [...queued.values()];
            queued.clear();
            for (const callback of due) callback();
        },
    };
}

describe('the preview’s frame throttle', () => {
    test('the first change shows at once, without waiting for a frame or for typing to stop', () => {
        const { frames } = manualFrames();
        let runs = 0;
        const throttle = frameThrottle(() => runs++, frames);
        throttle.call();
        expect(runs).toBe(1);
    });

    test('while keys keep coming, it shows once every frame, never more', () => {
        const { frames, frame } = manualFrames();
        let shown = '';
        let text = '';
        let runs = 0;
        const throttle = frameThrottle(() => {
            runs++;
            shown = text;
        }, frames);
        // Ten frames of typing, three keys in each: never a pause long enough for a debounce.
        for (let at = 0; at < 10; at++) {
            for (let key = 0; key < 3; key++) {
                text += 'a';
                throttle.call();
            }
            frame();
            // Each frame shows what was typed up to it.
            expect(shown).toBe(text);
        }
        // Once for the first key, then once a frame.
        expect(runs).toBe(11);
    });

    test('the last change of a burst is shown at the next frame', () => {
        const { frames, frame } = manualFrames();
        let shown = '';
        let text = '';
        const throttle = frameThrottle(() => {
            shown = text;
        }, frames);
        for (const key of 'hello') {
            text += key;
            throttle.call();
        }
        expect(shown).toBe('h');
        frame();
        expect(shown).toBe('hello');
        // Quiet afterwards: no run for nothing, and the next key shows at once again.
        frame();
        frame();
        text += '!';
        throttle.call();
        expect(shown).toBe('hello!');
    });

    test('cancel drops a waiting run', () => {
        const { frames, frame } = manualFrames();
        let runs = 0;
        const throttle = frameThrottle(() => runs++, frames);
        throttle.call();
        throttle.call();
        throttle.cancel();
        frame();
        expect(runs).toBe(1);
    });
});
