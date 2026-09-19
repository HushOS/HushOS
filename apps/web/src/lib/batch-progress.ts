import { useSyncExternalStore } from 'react';
import { downloads } from '@/lib/downloads';
import {
    batchProgress,
    HOLD_TICKS,
    NO_ESTIMATE,
    shownTimeLeft,
    smoothTimeLeft,
    type BatchProgress,
    type Smoothed,
} from '@/lib/progress';
import { transfers } from '@/lib/transfers';

/*
 * The batch view of every transfer, derived from the upload and download
 * stores and smoothed across their ticks. A store of its own because the
 * smoothing has memory: an estimate that jumps with each 750 ms sample is
 * worse than none, and React has no place for that memory during render.
 */

export type BatchView = {
    batch: BatchProgress;
    active: number;
    rate: number;
    timeLeft: number | null;
};

const EMPTY: BatchView = {
    batch: { files: { done: 0, total: 0 }, bytes: { loaded: 0, total: 0 }, secondsLeft: null },
    active: 0,
    rate: 0,
    timeLeft: null,
};
let snapshot = EMPTY;
let smoothed: Smoothed = NO_ESTIMATE;
// The rate line holds the last reading through the same short silences the estimate does.
let heldRate = { rate: 0, stale: 0 };
// When the batch began and how many files were already done, for the estimate by files.
let began: { at: number; filesDone: number } | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

/*
 * Seconds left by files: the batch's own pace so far, spread over what is
 * left. Bytes per second says little about a thousand small files, where the
 * time goes to starting each one; the longer of the two estimates is the
 * honest one, since either alone is a floor.
 */
function byFiles(batch: BatchProgress) {
    if (!began || batch.files.total < 2) return null;
    const finished = batch.files.done - began.filesDone;
    if (finished < 3) return null;
    const perFile = (Date.now() - began.at) / 1000 / finished;
    return (batch.files.total - batch.files.done) * perFile;
}

function recompute() {
    const up = transfers.getState();
    const down = downloads.getState();
    const live = up.bytesPerSecond + down.bytesPerSecond;
    const active = up.active + down.active;
    const batch = batchProgress(up.uploads, down.downloads, live);
    if (active === 0) {
        smoothed = NO_ESTIMATE;
        heldRate = { rate: 0, stale: 0 };
        began = null;
    } else {
        began ??= { at: Date.now(), filesDone: batch.files.done };
        heldRate =
            live > 0
                ? { rate: live, stale: 0 }
                : heldRate.stale + 1 >= HOLD_TICKS
                  ? { rate: 0, stale: 0 }
                  : { rate: heldRate.rate, stale: heldRate.stale + 1 };
        const estimates = [batch.secondsLeft, byFiles(batch)].filter(
            (value): value is number => value !== null,
        );
        smoothed = smoothTimeLeft(smoothed, estimates.length ? Math.max(...estimates) : null);
    }
    snapshot = {
        batch,
        active,
        rate: active > 0 ? heldRate.rate : live,
        timeLeft: active > 0 ? shownTimeLeft(smoothed) : null,
    };
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!unsubscribe) {
        const stops = [transfers.subscribe(recompute), downloads.subscribe(recompute)];
        unsubscribe = () => {
            for (const stop of stops) stop();
        };
        recompute();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
    };
}

export function useBatchProgress() {
    return useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => EMPTY,
    );
}
