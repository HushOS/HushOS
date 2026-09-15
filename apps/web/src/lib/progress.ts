import type { DownloadItem } from '@hushos/drive/downloads';
import type { UploadItem } from '@hushos/drive/transfers';

/*
 * The batch as one number: how many files and bytes are done out of the ones
 * that were queued, and how long the rest will take at the current rate. The
 * estimate counts only bytes that are actually moving; a paused or failed
 * file is in the totals (the bar does not lie about what was asked for) but
 * not in the time, since nothing is happening to it.
 */

export type BatchProgress = {
    files: { done: number; total: number };
    bytes: { loaded: number; total: number };
    /* Seconds until the moving bytes land, or null when nothing moves or the rate is unknown. */
    secondsLeft: number | null;
};

const MOVING = new Set(['queued', 'preparing', 'uploading', 'completing', 'downloading']);

export function batchProgress(
    uploads: readonly UploadItem[],
    downloads: readonly DownloadItem[],
    bytesPerSecond: number,
): BatchProgress {
    let total = 0;
    let done = 0;
    let loaded = 0;
    let size = 0;
    let remaining = 0;
    const count = (status: string, itemLoaded: number, itemSize: number | null, files: number) => {
        if (status === 'cancelled') return;
        total += files;
        const full = itemSize ?? itemLoaded;
        if (status === 'done') {
            done += files;
            loaded += full;
            size += full;
            return;
        }
        loaded += itemLoaded;
        size += Math.max(full, itemLoaded);
        // A download of unknown size cannot be estimated; it adds what it has and no more.
        if (MOVING.has(status) && itemSize !== null)
            remaining += Math.max(0, itemSize - itemLoaded);
    };
    for (const item of uploads) count(item.status, item.loaded, item.total, 1);
    for (const item of downloads) count(item.status, item.loaded, item.size, item.files);
    return {
        files: { done, total },
        bytes: { loaded, total: size },
        secondsLeft: remaining > 0 && bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
    };
}

/*
 * The estimate as a person reads it. Deliberately coarse: a rate measured over
 * 750 ms ticks is not a promise, and "about 4 min" survives a wobble that
 * "3:47" would not.
 */
export function formatTimeLeft(seconds: number) {
    if (seconds < 10) return 'a few seconds left';
    if (seconds < 60) return 'under a minute left';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `about ${hours} hr ${rest} min left` : `about ${hours} hr left`;
}

/*
 * Smooths the estimate between renders and holds it back until the rate has
 * settled: the first ticks of a transfer measure handshake, not throughput,
 * and an estimate that starts at "3 hr" and drops to "2 min" is worse than
 * none. `samples` counts consecutive ticks with a live estimate.
 */
export type Smoothed = { seconds: number | null; samples: number };
export const SETTLE_SAMPLES = 3;

export function smoothTimeLeft(previous: Smoothed, next: number | null): Smoothed {
    if (next === null) return { seconds: null, samples: 0 };
    const seconds = previous.seconds === null ? next : previous.seconds * 0.7 + next * 0.3;
    return { seconds, samples: previous.samples + 1 };
}

/* What to show: nothing until settled, else the smoothed estimate. */
export function shownTimeLeft(state: Smoothed) {
    return state.seconds !== null && state.samples >= SETTLE_SAMPLES ? state.seconds : null;
}
