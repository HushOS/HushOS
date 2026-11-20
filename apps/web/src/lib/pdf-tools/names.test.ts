import type { DriveNode } from '@hushos/drive/client';
import { expect, test } from 'vitest';
import {
    imagesFolderName,
    imagesStage,
    isPdf,
    mergedName,
    pageImageName,
    pdfToolsStage,
    rangesOf,
    splitName,
} from './names';
import { imageSize, pagesText, parsePages } from './protocol';

/*
 * The names Edit pages gives its results, the limits that decide the large-file card, and how the
 * worker's page list travels: each case is something a person would see go wrong.
 */

const MiB = 1024 * 1024;

test('split names a range with an en dash and a single page in the singular', () => {
    expect(splitName('Report.pdf', 1, 3)).toBe('Report (pages 1–3).pdf');
    expect(splitName('Report.pdf', 4, 4)).toBe('Report (page 4).pdf');
    // Only the last extension goes; a dotted name keeps its dots.
    expect(splitName('Q3.final.PDF', 2, 5)).toBe('Q3.final (pages 2–5).pdf');
    expect(splitName('.pdf', 1, 1)).toBe('.pdf (page 1).pdf');
});

test('merge and images take the first name without its extension', () => {
    expect(mergedName('Invoice March.pdf')).toBe('Invoice March (merged).pdf');
    expect(imagesFolderName('Report.pdf')).toBe('Report (images)');
    expect(pageImageName(0, 'png')).toBe('page 001.png');
    expect(pageImageName(41, 'jpeg')).toBe('page 042.jpg');
    expect(pageImageName(999, 'png')).toBe('page 1000.png');
});

test('cuts make ranges in order, ignoring repeats and a cut after the last page', () => {
    expect(rangesOf(4, [])).toEqual([[0, 3]]);
    expect(rangesOf(4, [2])).toEqual([
        [0, 2],
        [3, 3],
    ]);
    expect(rangesOf(4, [2, 0, 2, 3, -1, 9])).toEqual([
        [0, 0],
        [1, 2],
        [3, 3],
    ]);
    expect(rangesOf(3, [0, 1])).toEqual([
        [0, 0],
        [1, 1],
        [2, 2],
    ]);
});

test('the large-file card at 64 MB, the ceiling past 256 MB or 100 files', () => {
    expect(pdfToolsStage(1, 64 * MiB)).toBe('fine');
    expect(pdfToolsStage(1, 64 * MiB + 1)).toBe('offer');
    expect(pdfToolsStage(100, 256 * MiB)).toBe('offer');
    expect(pdfToolsStage(100, 256 * MiB + 1)).toBe('ceiling');
    expect(pdfToolsStage(101, 1)).toBe('ceiling');
    expect([50, 51, 500, 501].map(imagesStage)).toEqual(['fine', 'offer', 'offer', 'ceiling']);
});

test('PDFs are known by type or extension, never a version that is missing', () => {
    const node = (name: string, mime: string | null, status = 'ready') =>
        ({
            kind: 'file',
            name,
            metadata: mime ? { mime } : null,
            currentVersion: { objectStatus: status },
        }) as unknown as DriveNode;
    expect(isPdf(node('a.pdf', null))).toBe(true);
    expect(isPdf(node('scan', 'application/pdf'))).toBe(true);
    expect(isPdf(node('a.txt', 'text/plain'))).toBe(false);
    expect(isPdf(node('a.pdf', 'application/pdf', 'missing'))).toBe(false);
});

test('a page list goes to the page and back exactly, and anything else is refused', () => {
    const pages = [
        { width: 612, height: 792, rotate: 0 as const },
        { width: 595.28, height: 841.89, rotate: 270 as const },
    ];
    expect(parsePages(pagesText(pages))).toEqual(pages);
    for (const bad of ['', '612 792', '612 792 45', 'a b 0', '612 792 0,', '-1 2 0', 1, null])
        expect(parsePages(bad), String(bad)).toBeNull();
    expect(parsePages(Array(3).fill('1 1 0').join(','), 2)).toBeNull();
});

test('an image is the page at its resolution, turned with the page', () => {
    expect(imageSize({ width: 612, height: 792 }, 0, 150)).toEqual({ width: 1275, height: 1650 });
    expect(imageSize({ width: 612, height: 792 }, 90, 300)).toEqual({ width: 3300, height: 2550 });
    expect(imageSize({ width: 595, height: 842 }, 180, 150)).toEqual({ width: 1240, height: 1754 });
    expect(imageSize({ width: 0.1, height: 0.1 }, 0, 150)).toEqual({ width: 1, height: 1 });
});
