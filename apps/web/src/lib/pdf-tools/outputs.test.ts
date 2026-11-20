// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DriveNode } from '@hushos/drive/client';
import { expect, test } from 'vitest';
import { ToolError } from '@/lib/tools/worker';
import { inspectAll } from './inspect';
import { imagesPlan, OutputLedger, OutputMismatch, PageTooLarge, sourcesFor } from './outputs';
import { readPdf } from './structure';

/*
 * What the page holds a worker's results to, the plans made before a save, and inspection's walk
 * over several PDFs: each case a way a save would end wrong or a look would read too much.
 */

const FIXTURES = join(__dirname, '../../../../../e2e/fixtures/pdfs');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

test('a result not asked for, out of turn, twice, or of the wrong type stops the save; one missing too', () => {
    const fresh = () => new OutputLedger(['a.pdf', 'b.pdf'], 'application/pdf');
    expect(() => fresh().take('c.pdf', 'application/pdf')).toThrow(OutputMismatch);
    expect(() => fresh().take('b.pdf', 'application/pdf')).toThrow(OutputMismatch);
    expect(() => fresh().take('a.pdf', 'image/png')).toThrow(OutputMismatch);
    const twice = fresh();
    expect(twice.take('a.pdf', 'application/pdf')).toBe(0);
    expect(() => twice.take('a.pdf', 'application/pdf')).toThrow(OutputMismatch);
    // Done after one of two: the second is missing.
    const short = fresh();
    short.take('a.pdf', 'application/pdf');
    expect(() => short.complete()).toThrow(OutputMismatch);
    const whole = fresh();
    whole.take('a.pdf', 'application/pdf');
    expect(whole.take('b.pdf', 'application/pdf')).toBe(1);
    expect(() => whole.complete()).not.toThrow();
    expect(() => whole.take('b.pdf', 'application/pdf')).toThrow(OutputMismatch);
});

test('an image is signed by the PDF its page came from, a merge by every PDF in it', () => {
    const nodes = [{ id: 'strong' }, { id: 'weak' }] as unknown as DriveNode[];
    const ids = (pages: { source: number }[]) =>
        sourcesFor(
            nodes,
            pages.map((page) => ({ ...page, page: 0, rotate: 0 as const })),
        ).map((source) => (source.node as unknown as { id: string }).id);
    expect(ids([{ source: 0 }])).toEqual(['strong']);
    expect(ids([{ source: 1 }, { source: 0 }, { source: 1 }])).toEqual(['strong', 'weak']);
});

test('a page too large to draw is refused by its number before anything is planned', () => {
    const letter = { width: 612, height: 792, rotate: 0 as const };
    const pages = [0, 1].map((page) => ({ source: 0, page, rotate: 0 as const }));
    expect(imagesPlan(pages, [letter, letter], 150)).toEqual([
        { width: 1275, height: 1650 },
        { width: 1275, height: 1650 },
    ]);
    // A MediaBox a million points wide: never multiplied into a room estimate, refused as page 2.
    const huge = { width: 1e12, height: 1e12, rotate: 0 as const };
    expect(() => imagesPlan(pages, [letter, huge], 150)).toThrow(new PageTooLarge(2));
    // 40 megapixels and one more.
    const edge = {
        width: (40_000_000 / 2000) * (72 / 150),
        height: 2000 * (72 / 150),
        rotate: 0 as const,
    };
    expect(() => imagesPlan([pages[0]!], [edge], 150)).not.toThrow();
    expect(() => imagesPlan([pages[0]!], [{ ...edge, width: edge.width + 1 }], 150)).toThrow(
        PageTooLarge,
    );
});

test('inspection stops at the PDF that passes the run’s pages, without reading the rest', async () => {
    const opened: number[] = [];
    const open = async (index: number, maxPages: number) => {
        opened.push(index);
        return readPdf(fixture('plain.pdf'), { maxPages });
    };
    // Three-page PDFs against five pages: the second passes them together, the third is never read.
    await expect(inspectAll(3, open, { maxPages: 5 })).rejects.toEqual(
        new ToolError('too-many-pages-together'),
    );
    expect(opened).toEqual([0, 1]);
    // One that passes them alone is refused as itself, and the walk goes on.
    opened.length = 0;
    const alone = await inspectAll(2, open, { maxPages: 2 });
    expect(alone).toEqual([
        { ok: false, reason: 'too-many-pages' },
        { ok: false, reason: 'too-many-pages' },
    ]);
    // Within them, every PDF is read.
    opened.length = 0;
    const fits = await inspectAll(2, open, { maxPages: 6 });
    expect(fits.map((source) => source.ok)).toEqual([true, true]);
});
