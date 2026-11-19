// @vitest-environment node
import { expect, test } from 'vitest';
import { fixture, imageBox, leaks, looksUpright, readPdf } from './pdf-reader.testkit';

/*
 * The phones' PDF, as the core's writer makes it (crates/hushos-core/src/images_pdf.rs; a core
 * test holds e2e/fixtures/images/core-made.pdf to what the writer makes now), opened by pdf.js.
 */

test('pdf.js opens the core’s PDF, every page upright and nothing of the images’ metadata in it', async () => {
    const bytes = fixture('core-made.pdf');
    expect(leaks(bytes)).toEqual([]);
    const pages = await readPdf(bytes);
    expect(pages).toHaveLength(6);
    // A4 with 12 mm margins, each page turned to its (wider than tall) image.
    for (const page of pages) {
        expect(page.width).toBeCloseTo(841.89, 1);
        expect(page.height).toBeCloseTo(595.28, 1);
    }
    const [page1, phone, cmyk, grey, gps, disc] = pages;
    for (const page of [page1, phone, cmyk, gps]) expect(looksUpright(page!)).toBe(true);
    // The phone photo is stored sideways: the reader turns it upright with the page's matrix.
    expect(phone!.image).toEqual({ width: 300, height: 400 });
    const [x, y, w, h] = imageBox(grey!);
    expect(grey!.at(x + w / 2, y + h * 0.97)![0]).toBeLessThan(
        grey!.at(x + w / 2, y + h / 2)![0] - 60,
    );
    const [dx, dy, dw, dh] = imageBox(disc!);
    expect(disc!.at(dx + dw / 2, dy + dh / 2)?.[0]).toBeGreaterThan(150);
    expect(disc!.at(dx + 1, dy + 1)).toBeNull();
});
