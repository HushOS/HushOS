import { WATCHDOG_TICK_CAP_MS, WATCHDOG_TICK_MS } from './protocol';

/*
 * The run's watchdog: fires once the worker has gone `limitMs` without reporting progress.
 * The clock is brought up to date every second, and one tick adds at most two seconds, so a
 * tab the browser froze or slept does not count the time the worker never had. Time the
 * worker spends waiting on the page (a range being fetched and decrypted, a full budget while
 * uploads drain or are paused) is not counted: the clock stops at `hold` and runs on from
 * where it stopped when the last hold ends. A read does not start the clock over, so a parser
 * looping over the same ranges still runs out of time.
 */
export function createWatchdog(limitMs: number, onTimeout: () => void) {
    let idle = 0;
    let last = Date.now();
    let holds = 0;
    let stopped = false;

    function bringUp() {
        const now = Date.now();
        const passed = Math.min(Math.max(0, now - last), WATCHDOG_TICK_CAP_MS);
        if (holds === 0) idle += passed;
        last = now;
    }

    const timer = setInterval(() => {
        if (stopped) return;
        bringUp();
        if (idle < limitMs) return;
        stop();
        onTimeout();
    }, WATCHDOG_TICK_MS);

    function stop() {
        stopped = true;
        clearInterval(timer);
    }

    return {
        progress() {
            idle = 0;
            last = Date.now();
        },
        /* A wait on the page; call what it returns when the wait ends. */
        hold() {
            bringUp();
            holds++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                bringUp();
                holds--;
            };
        },
        stop,
    };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
