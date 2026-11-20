import { describe, expect, test } from 'vitest';
import { transferHeadline, waitsForKeyChange } from './transfer-headline';

const up = (status: string, waitingFor: string | null = null) =>
    ({ status, waitingFor }) as Parameters<typeof waitsForKeyChange>[0];
const KEYS = 'Finishing a key change…';

describe('the transfers headline', () => {
    test('an upload waiting for a key change is never said as uploading', () => {
        // Between its pauses the engine counts it as working; the headline must not.
        for (const status of ['preparing', 'completing'])
            expect(
                transferHeadline({
                    uploads: [up(status, KEYS)],
                    downloads: [],
                    downloadsActive: 0,
                    offline: false,
                }),
            ).toMatchObject({
                title: '1 file waiting for a key change',
                mode: 'waiting',
                moving: 0,
            });
        expect(
            transferHeadline({
                uploads: [up('preparing', KEYS), up('completing', KEYS)],
                downloads: [],
                downloadsActive: 0,
                offline: true,
            }).title,
        ).toBe('2 files waiting for a key change');
    });

    test('what moves beside a waiting upload leads, counted without it', () => {
        expect(
            transferHeadline({
                uploads: [up('preparing', KEYS), up('uploading')],
                downloads: [],
                downloadsActive: 0,
                offline: false,
            }),
        ).toMatchObject({ title: 'Uploading 1 file', mode: 'moving', uploading: 1, waiting: 1 });
        expect(
            transferHeadline({
                uploads: [up('preparing', KEYS)],
                downloads: [{ status: 'downloading' }],
                downloadsActive: 1,
                offline: false,
            }),
        ).toMatchObject({ title: 'Downloading 1 file', moving: 1 });
    });

    test('a key change that has finished leaves an upload like any other', () => {
        // Sending or settled, a left-over reason no longer holds it back.
        expect(waitsForKeyChange(up('uploading', KEYS))).toBe(false);
        expect(waitsForKeyChange(up('done', KEYS))).toBe(false);
        expect(waitsForKeyChange(up('preparing'))).toBe(false);
        expect(
            transferHeadline({
                uploads: [up('preparing')],
                downloads: [],
                downloadsActive: 0,
                offline: true,
            }).title,
        ).toBe('Waiting for a connection');
    });
});
