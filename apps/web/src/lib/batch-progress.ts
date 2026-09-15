import { useSyncExternalStore } from 'react';
import { downloads } from '@/lib/downloads';
import {
    batchProgress,
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
let smoothed: Smoothed = { seconds: null, samples: 0 };
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function recompute() {
    const up = transfers.getState();
    const down = downloads.getState();
    const rate = up.bytesPerSecond + down.bytesPerSecond;
    const active = up.active + down.active;
    const batch = batchProgress(up.uploads, down.downloads, rate);
    smoothed = smoothTimeLeft(smoothed, active > 0 ? batch.secondsLeft : null);
    snapshot = { batch, active, rate, timeLeft: active > 0 ? shownTimeLeft(smoothed) : null };
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
