/*
 * Runs `work` at most once a frame while calls keep coming, never later than the frame after the
 * last call. Leading: a call after a quiet frame runs at once. Trailing: calls during the frame after
 * a run are folded into one run when that frame comes, so the last change is always shown. Unlike a
 * debounce, it never waits for the calls to stop: the editor's preview moves while typing goes on.
 */
export type FrameThrottle = {
    call: () => void;
    /* Drops a run waiting for its frame; the next call runs at once. */
    cancel: () => void;
};

type Frames = {
    request: (callback: () => void) => number;
    cancel: (id: number) => void;
};

const animationFrames: Frames = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
};

export function frameThrottle(work: () => void, frames: Frames = animationFrames): FrameThrottle {
    /* The frame that ends the current window; null when quiet. */
    let frame: number | null = null;
    /* A call came during the window: run once more when it ends. */
    let waiting = false;
    const tick = () => {
        frame = null;
        if (!waiting) return;
        waiting = false;
        // Another window after this run, so a burst still gets one run a frame.
        frame = frames.request(tick);
        work();
    };
    return {
        call() {
            if (frame !== null) {
                waiting = true;
                return;
            }
            frame = frames.request(tick);
            work();
        },
        cancel() {
            if (frame !== null) frames.cancel(frame);
            frame = null;
            waiting = false;
        },
    };
}
