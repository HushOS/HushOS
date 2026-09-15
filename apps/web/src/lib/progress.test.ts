import { describe, expect, test } from 'vitest';
import type { DownloadItem } from '@hushos/drive/downloads';
import type { UploadItem } from '@hushos/drive/transfers';
import {
    batchProgress,
    formatTimeLeft,
    SETTLE_SAMPLES,
    shownTimeLeft,
    smoothTimeLeft,
    type Smoothed,
} from './progress';

const up = (status: UploadItem['status'], loaded: number, total: number) =>
    ({ id: `${status}-${loaded}`, status, loaded, total }) as UploadItem;
const down = (status: DownloadItem['status'], loaded: number, size: number | null, files = 1) =>
    ({ id: `d-${status}-${loaded}`, status, loaded, size, files }) as DownloadItem;

describe('batch progress', () => {
    test('counts what was asked for, credits a done file in full, and leaves cancelled ones out', () => {
        const p = batchProgress(
            [
                up('done', 90, 100),
                up('uploading', 40, 100),
                up('queued', 0, 100),
                up('cancelled', 0, 100),
            ],
            [],
            50,
        );
        expect(p.files).toEqual({ done: 1, total: 3 });
        // The done file counts its full size even if its last tick lagged behind.
        expect(p.bytes).toEqual({ loaded: 140, total: 300 });
        // 60 + 100 bytes still to move at 50 B/s.
        expect(p.secondsLeft).toBe(160 / 50);
    });

    test('a paused or failed file stays in the totals but not in the time', () => {
        const p = batchProgress(
            [up('uploading', 50, 100), up('paused', 10, 100), up('failed', 0, 100)],
            [],
            10,
        );
        expect(p.files.total).toBe(3);
        expect(p.bytes).toEqual({ loaded: 60, total: 300 });
        expect(p.secondsLeft).toBe(50 / 10);
    });

    test('downloads count their files and a download of unknown size cannot be estimated', () => {
        const p = batchProgress(
            [],
            [down('downloading', 30, 100), down('downloading', 70, null, 3), down('done', 20, 20)],
            10,
        );
        expect(p.files).toEqual({ done: 1, total: 5 });
        expect(p.bytes).toEqual({ loaded: 120, total: 190 });
        expect(p.secondsLeft).toBe(70 / 10);
    });

    test('no rate, or nothing moving, means no estimate rather than a bogus one', () => {
        expect(batchProgress([up('uploading', 10, 100)], [], 0).secondsLeft).toBeNull();
        expect(batchProgress([up('paused', 10, 100)], [], 10).secondsLeft).toBeNull();
        expect(batchProgress([], [], 10)).toEqual({
            files: { done: 0, total: 0 },
            bytes: { loaded: 0, total: 0 },
            secondsLeft: null,
        });
    });
});

describe('time left, as read', () => {
    test('is coarse on purpose and switches units at the right places', () => {
        expect(formatTimeLeft(3)).toBe('a few seconds left');
        expect(formatTimeLeft(9.9)).toBe('a few seconds left');
        expect(formatTimeLeft(10)).toBe('under a minute left');
        expect(formatTimeLeft(59)).toBe('under a minute left');
        expect(formatTimeLeft(60)).toBe('about 1 min left');
        expect(formatTimeLeft(3569)).toBe('about 59 min left');
        expect(formatTimeLeft(3600)).toBe('about 1 hr left');
        expect(formatTimeLeft(4200)).toBe('about 1 hr 10 min left');
    });

    test('is held back until the rate has settled, then smoothed toward new readings', () => {
        let s: Smoothed = { seconds: null, samples: 0 };
        for (let i = 0; i < SETTLE_SAMPLES - 1; i++) {
            s = smoothTimeLeft(s, 600);
            expect(shownTimeLeft(s)).toBeNull();
        }
        s = smoothTimeLeft(s, 600);
        expect(shownTimeLeft(s)).toBe(600);
        // A sudden reading moves the estimate part of the way, not all of it.
        s = smoothTimeLeft(s, 100);
        expect(shownTimeLeft(s)).toBeCloseTo(600 * 0.7 + 100 * 0.3);
        // Losing the rate resets: the next transfer settles on its own.
        s = smoothTimeLeft(s, null);
        expect(shownTimeLeft(s)).toBeNull();
        expect(smoothTimeLeft(s, 50).samples).toBe(1);
    });
});
