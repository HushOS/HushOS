/*
 * The run's watchdog: fires once the worker has gone `limitMs` without reporting progress.
 * Time the worker spends waiting on the page (a range being fetched and decrypted, a full
 * budget while uploads drain or are paused) is not counted: the clock stops at `hold` and
 * runs on from where it stopped when the last hold ends. A read does not start the clock
 * over, so a parser looping over the same ranges still runs out of time.
 */
export function createWatchdog(limitMs: number, onTimeout: () => void) {
    let idle = 0;
    let since = Date.now();
    let holds = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function arm() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (stopped || holds > 0) return;
        timer = setTimeout(
            () => {
                timer = null;
                if (stopped || holds > 0) return;
                stopped = true;
                onTimeout();
            },
            Math.max(0, limitMs - idle),
        );
    }

    arm();
    return {
        progress() {
            idle = 0;
            since = Date.now();
            arm();
        },
        /* A wait on the page; call what it returns when the wait ends. */
        hold() {
            if (holds++ === 0) idle += Date.now() - since;
            arm();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (--holds === 0) since = Date.now();
                arm();
            };
        },
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
