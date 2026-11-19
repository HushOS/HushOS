// @vitest-environment node
import { expect, test } from 'vitest';
import { pageLayout } from './geometry';
import { cutJpeg } from './jpeg';
import { ImageRefused, ImagesPdf, isHeic, pngSize, sniff, type PdfOptions } from './pdf';
import { contains, fixture, imageBox, leaks, looksUpright, readPdf } from './pdf-reader.testkit';

/*
 * One PDF as the worker builds it with pdf-lib, read back with pdf.js: the pages in the order
 * given, each image upright whatever its EXIF orientation, each JPEG's bytes as cut, and none
 * of the metadata the cutter cuts.
 */

async function build(names: string[], options: PdfOptions = { size: 'fit', margin: false }) {
    const pdf = await ImagesPdf.create(options);
    for (const [index, name] of names.entries()) {
        const bytes = fixture(name);
        if (sniff(bytes) === 'png') await pdf.addPng(bytes, index);
        else pdf.addJpeg(bytes, index);
    }
    return pdf.save();
}

test('three images make three pages in the order given', async () => {
    const order = ['page-2.jpg', 'page-3.jpg', 'page-1.jpg'];
    const pages = await readPdf(await build(order));
    // page-1 is 300x200, page-2 200x300, page-3 250x250: with Fit, each page is its image.
    expect(pages.map((page) => [page.width, page.height])).toEqual([
        [200, 300],
        [250, 250],
        [300, 200],
    ]);
    for (const page of pages) expect(looksUpright(page)).toBe(true);
});

test('every EXIF orientation stands upright, turned on the page and never re-encoded', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `orientation-${i + 1}.jpg`);
    const bytes = await build(names);
    const pages = await readPdf(bytes);
    pages.forEach((page, i) => {
        expect(looksUpright(page), names[i]).toBe(true);
        // Shown 60x40 whichever way it was stored.
        expect([page.width, page.height], names[i]).toEqual([60, 40]);
    });
    for (const name of names)
        expect(contains(bytes, cutJpeg(fixture(name)).bytes), name).toBe(true);
});

test('a phone photo with GPS: upright, and nothing of its EXIF in the PDF', async () => {
    const bytes = await build([
        'phone-rotated.jpg',
        'gps.jpg',
        'xmp.jpg',
        'iptc.jpg',
        'mpf-trailer.jpg',
        'between-scans.jpg',
    ]);
    expect(leaks(bytes)).toEqual([]);
    const [phone] = await readPdf(bytes);
    expect([phone!.width, phone!.height]).toEqual([400, 300]);
    expect(looksUpright(phone!)).toBe(true);
    // No document information either: pdf-lib's Producer and dates are left out.
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).not.toMatch(/\/Producer|\/Creator|\/CreationDate|\/ModDate|\/Info/);
});

test('A4 and Letter turn to the image and keep the margins', async () => {
    const a4 = await readPdf(
        await build(['page-1.jpg', 'page-2.jpg'], { size: 'a4', margin: true }),
    );
    expect(a4[0]!.width).toBeCloseTo(841.89, 1);
    expect(a4[0]!.height).toBeCloseTo(595.28, 1);
    expect(a4[1]!.width).toBeCloseTo(595.28, 1);
    const [x, y, w, h] = imageBox(a4[0]!);
    const margin = (12 * 72) / 25.4;
    // 300x200 on landscape A4 inside 12 mm: the width is what limits it, so the margin is exact there.
    expect(x).toBeCloseTo(margin, 3);
    expect(x + w).toBeCloseTo(a4[0]!.width - margin, 3);
    expect(y).toBeGreaterThan(margin);
    expect(y + h / 2).toBeCloseTo(a4[0]!.height / 2, 3);
    expect(w / h).toBeCloseTo(1.5, 6);
    const letter = await readPdf(await build(['page-2.jpg'], { size: 'letter', margin: false }));
    expect([letter[0]!.width, letter[0]!.height]).toEqual([612, 792]);
    expect(imageBox(letter[0]!)[3]).toBeCloseTo(792, 3);
    expect(letter[0]!.matrix).toEqual(
        pageLayout(200, 300, 1, 'letter', false).matrix.map((v) => expect.closeTo(v, 4)),
    );
});

test('a PNG keeps its transparency, and CMYK and grey JPEGs show their colours', async () => {
    const pages = await readPdf(
        await build(['alpha.png', 'adobe-cmyk.jpg', 'grey.jpg', 'plain-cmyk.jpg']),
    );
    const [disc, cmyk, grey, plainCmyk] = pages;
    // CMYK without Adobe's marker is not complemented: inverting it would show cyan for red.
    expect(looksUpright(plainCmyk!)).toBe(true);
    expect(disc!.at(32, 24)?.[0]).toBeGreaterThan(150);
    expect(disc!.at(1, 1)).toBeNull();
    expect(looksUpright(cmyk!)).toBe(true);
    // Grey: the top band is darker than the ground.
    const [x, y, w, h] = imageBox(grey!);
    expect(grey!.at(x + w / 2, y + h * 0.97)![0]).toBeLessThan(
        grey!.at(x + w / 2, y + h / 2)![0] - 60,
    );
});

test('a damaged or unsupported image is refused by its place in the order', async () => {
    const pdf = await ImagesPdf.create({ size: 'fit', margin: false });
    pdf.addJpeg(fixture('plain.jpg'), 0);
    expect(() => pdf.addJpeg(fixture('truncated-segment.jpg'), 1)).toThrow(
        new ImageRefused('damaged', 1),
    );
    expect(() => pdf.addJpeg(fixture('arithmetic.jpg'), 2)).toThrow(
        new ImageRefused('unsupported', 2),
    );
    await expect(pdf.addPng(fixture('plain.jpg'), 3)).rejects.toEqual(
        new ImageRefused('damaged', 3),
    );
    const huge = fixture('alpha.png').slice();
    new DataView(huge.buffer).setUint32(16, 20_000);
    new DataView(huge.buffer).setUint32(20, 5_001);
    await expect(pdf.addPng(huge, 4)).rejects.toEqual(new ImageRefused('too-many-pixels', 4));
    expect(pdf.pages).toBe(1);
});

test('kinds are told by their bytes', () => {
    expect(sniff(fixture('plain.jpg'))).toBe('jpeg');
    expect(sniff(fixture('png-named-jpg.jpg'))).toBe('png');
    expect(sniff(fixture('photo.webp'))).toBe('other');
    expect(pngSize(fixture('alpha.png'))).toEqual({ width: 64, height: 48 });
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    expect(isHeic(heic)).toBe(true);
    const avif = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0]);
    expect(isHeic(avif)).toBe(false);
});
