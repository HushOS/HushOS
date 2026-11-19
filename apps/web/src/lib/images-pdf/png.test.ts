// @vitest-environment node
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { ImagesPdf } from './pdf';
import { contains, looksUpright, readPdf } from './pdf-reader.testkit';
import { preparePng, PngRefused, rawSize } from './png';

/*
 * PNGs checked and stripped before pdf-lib decodes them: an animated one and a zlib bomb are refused
 * without being inflated in full, chunks the picture doesn't need are gone, and an eXIf orientation
 * turns the page as a browser shows the picture.
 */

const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
};
const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};
const ihdr = (width: number, height: number) => {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    data.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, not interlaced
    return chunk('IHDR', data);
};
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* An RGBA PNG of `pixel(x, y)`, with any extra chunks before its image data. */
function png(
    width: number,
    height: number,
    pixel: (x: number, y: number) => number[],
    extra: Uint8Array[] = [],
) {
    const raw = new Uint8Array(height * (1 + width * 4));
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
    return join(
        SIGNATURE,
        ihdr(width, height),
        ...extra,
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array(0)),
    );
}

test('an animated PNG is refused before any frame is decoded', () => {
    const frames = new Uint8Array(8);
    new DataView(frames.buffer).setUint32(0, 2);
    const apng = png(4, 4, () => [255, 0, 0, 255], [chunk('acTL', frames)]);
    expect(() => preparePng(apng)).toThrow(new PngRefused('animated'));
});

test('image data that inflates past what its header says is refused as it inflates', () => {
    // A 16x16 header (1,040 bytes of rows) over 512 MiB of zeros, about 500 KiB deflated.
    const bomb = deflateSync(new Uint8Array(512 * 1024 * 1024), { level: 9 });
    const file = join(
        SIGNATURE,
        ihdr(16, 16),
        chunk('IDAT', bomb),
        chunk('IEND', new Uint8Array(0)),
    );
    const started = performance.now();
    expect(() => preparePng(file)).toThrow(new PngRefused('damaged'));
    // Stopped within its first pieces, not after inflating half a gigabyte.
    expect(performance.now() - started).toBeLessThan(1_000);
    // And data short of what the header says is damaged too.
    const short = join(
        SIGNATURE,
        ihdr(16, 16),
        chunk('IDAT', deflateSync(new Uint8Array(100))),
        chunk('IEND', new Uint8Array(0)),
    );
    expect(() => preparePng(short)).toThrow(new PngRefused('damaged'));
    expect(rawSize(16, 16, 8, 4, false)).toBe(16 * (1 + 64));
});

test('a header the specification doesn’t allow is refused before it can widen the bound', () => {
    // A palette image claiming 16 bits a sample, its data inflating to exactly what that would allow:
    // twice what a real palette image of its size holds.
    const header = (depth: number, type: number, rest = [0, 0, 0]) => {
        const data = new Uint8Array(13);
        const view = new DataView(data.buffer);
        view.setUint32(0, 16);
        view.setUint32(4, 16);
        data.set([depth, type, ...rest], 8);
        return chunk('IHDR', data);
    };
    const widened = new Uint8Array(rawSize(16, 16, 16, 1, false));
    const file = (ihdrChunk: Uint8Array) =>
        join(
            SIGNATURE,
            ihdrChunk,
            chunk('PLTE', new Uint8Array(3)),
            chunk('IDAT', deflateSync(widened)),
            chunk('IEND', new Uint8Array(0)),
        );
    expect(() => preparePng(file(header(16, 3)))).toThrow(new PngRefused('damaged'));
    expect(() => preparePng(file(header(8, 3, [1, 0, 0])))).toThrow(new PngRefused('damaged')); // compression 1
    expect(() => preparePng(file(header(8, 3, [0, 0, 2])))).toThrow(new PngRefused('damaged')); // interlace 2
});

test('only the chunks the picture needs reach pdf-lib', () => {
    const text = chunk('tEXt', new TextEncoder().encode('Comment\0HUSHOS-CANARY-PNG-TEXT'));
    const prepared = preparePng(png(4, 4, () => [255, 0, 0, 255], [text]));
    expect(contains(prepared.png, new TextEncoder().encode('HUSHOS-CANARY-PNG-TEXT'))).toBe(false);
    expect(contains(prepared.png, new TextEncoder().encode('tEXt'))).toBe(false);
    expect(prepared.orientation).toBe(1);
});

test('a PNG with eXIf orientation 6 stands upright on its page', async () => {
    // Shown 60x40: red along the top, green down the left, blue at bottom right; stored a quarter turn back.
    const shown = (x: number, y: number) =>
        y < 7
            ? [220, 20, 20, 255]
            : x < 8
              ? [20, 160, 40, 255]
              : x >= 45 && y >= 30
                ? [30, 60, 220, 255]
                : [235, 235, 230, 255];
    // Orientation 6 shows stored (col, row) at (height - 1 - row, col): stored is 40 wide, 60 high.
    const stored = png(40, 60, (col, row) => shown(59 - row, col), [
        chunk(
            'eXIf',
            new Uint8Array([
                0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0,
                0, 0, 0,
            ]),
        ),
    ]);
    expect(preparePng(stored).orientation).toBe(6);
    const pdf = await ImagesPdf.create({ size: 'fit', margin: false });
    await pdf.addPng(stored, 0);
    const [page] = await readPdf(await pdf.save());
    expect([page!.width, page!.height]).toEqual([60, 40]);
    expect(looksUpright(page!)).toBe(true);
});
