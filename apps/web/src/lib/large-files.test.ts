import { describe, expect, it } from 'vitest';
import { imageCeiling, largeFileStage, type Device } from '@/lib/large-files';

const MiB = 1024 * 1024;
const desktop: Device = { deviceMemory: 8, coarse: false };

describe('largeFileStage', () => {
    // [kind, threshold, ceiling] as the card promises them in DESIGN.md.
    const limits = [
        ['colour', 512 * 1024, 4 * MiB],
        ['text', 8 * MiB, 32 * MiB],
        ['office', 32 * MiB, 64 * MiB],
        ['image', 100 * MiB, 300 * MiB],
    ] as const;

    for (const [kind, threshold, ceiling] of limits) {
        it(`${kind}: opens at its threshold, offers one byte past it, refuses one byte past its ceiling`, () => {
            expect(largeFileStage(kind, threshold, desktop)).toBe('fine');
            expect(largeFileStage(kind, threshold + 1, desktop)).toBe('offer');
            expect(largeFileStage(kind, ceiling, desktop)).toBe('offer');
            expect(largeFileStage(kind, ceiling + 1, desktop)).toBe('ceiling');
        });
    }

    it('leaves a file whose size is unreadable to its own error, not the ceiling card', () => {
        expect(largeFileStage('image', Number.NaN, desktop)).toBe('fine');
        expect(largeFileStage('text', Number.POSITIVE_INFINITY, desktop)).toBe('fine');
    });

    it('offers no Open anyway for a large image on a device that reports 2 GB', () => {
        expect(largeFileStage('image', 100 * MiB + 1, { deviceMemory: 2, coarse: false })).toBe(
            'ceiling',
        );
    });
});

describe('imageCeiling', () => {
    it('follows the memory the browser reports', () => {
        expect(imageCeiling({ deviceMemory: 2, coarse: false })).toBe(100 * MiB);
        expect(imageCeiling({ deviceMemory: 4, coarse: true })).toBe(200 * MiB);
        expect(imageCeiling({ deviceMemory: 8, coarse: true })).toBe(300 * MiB);
    });

    it('takes a touch screen that reports nothing for a phone, and a mouse for a computer', () => {
        expect(imageCeiling({ deviceMemory: undefined, coarse: true })).toBe(200 * MiB);
        expect(imageCeiling({ deviceMemory: undefined, coarse: false })).toBe(300 * MiB);
    });
});
