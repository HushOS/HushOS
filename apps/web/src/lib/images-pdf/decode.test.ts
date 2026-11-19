// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { DECODE_BLOB_MAX, decodeForPdf, thumbnailOf } from './decode';
import { imageSize } from './dimensions';
import { ImageRefused } from './pdf';
import { fixture } from './pdf-reader.testkit';

/*
 * Sizes read from headers before anything decodes, and the refusals that come of them: a file
 * that would decode past MAX_PIXELS, or that is too large to hand the browser as a Blob, never
 * reaches createImageBitmap.
 */

afterEach(() => vi.unstubAllGlobals());

/* A PNG whose header claims `width` x `height`: a bomb's header, with nothing behind it. */
function pngClaiming(width: number, height: number) {
    const bytes = fixture('alpha.png').slice();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

test('sizes come from every kind’s header', () => {
    expect(imageSize(fixture('alpha.png'))).toEqual({ width: 64, height: 48 });
    expect(imageSize(fixture('plain.jpg'))).toEqual({ width: 240, height: 160 });
    expect(imageSize(fixture('progressive.jpg'))).toEqual({ width: 240, height: 160 });
    expect(imageSize(fixture('photo.webp'))).toEqual({ width: 240, height: 160 });
    expect(imageSize(fixture('photo-lossless.webp'))).toEqual({ width: 240, height: 160 });
    expect(imageSize(fixture('photo.gif'))).toEqual({ width: 240, height: 160 });
    expect(imageSize(fixture('photo.bmp'))).toEqual({ width: 240, height: 160 });
    // HEIF: the largest ispe (a grid's), not a tile's.
    const box = (width: number, height: number) => {
        const out = new Uint8Array(20);
        const view = new DataView(out.buffer);
        view.setUint32(0, 20);
        out.set(new TextEncoder().encode('ispe'), 4);
        view.setUint32(12, width);
        view.setUint32(16, height);
        return out;
    };
    const heic = new Uint8Array([
        0,
        0,
        0,
        16,
        ...new TextEncoder().encode('ftypheic'),
        0,
        0,
        0,
        0,
        ...box(512, 512),
        ...box(4032, 3024),
    ]);
    expect(imageSize(heic)).toEqual({ width: 4032, height: 3024 });
    expect(
        imageSize(new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode('ftypheic')])),
    ).toBeNull();
    expect(imageSize(new TextEncoder().encode('not an image at all'))).toBeNull();
});

test('a file that would decode past the pixel limit is refused before the browser sees it', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('decoded')));
    vi.stubGlobal('createImageBitmap', decode);
    await expect(decodeForPdf(pngClaiming(12_000, 9_000), 2)).rejects.toEqual(
        new ImageRefused('too-many-pixels', 2),
    );
    // An unreadable header is refused too, not decoded blind.
    await expect(decodeForPdf(new TextEncoder().encode('garbage'), 1)).rejects.toEqual(
        new ImageRefused('damaged', 1),
    );
    // And the thumbnail, which is optional, is simply not made.
    expect(await thumbnailOf(pngClaiming(12_000, 9_000), 512, 65_536)).toBeNull();
    expect(decode).not.toHaveBeenCalled();
});

test('nothing larger than an image preview is handed to the browser as a Blob', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('decoded')));
    vi.stubGlobal('createImageBitmap', decode);
    const large = new Uint8Array(DECODE_BLOB_MAX + 1);
    large.set(fixture('photo.webp'));
    await expect(decodeForPdf(large, 0)).rejects.toEqual(
        new ImageRefused('too-large-to-decode', 0),
    );
    expect(await thumbnailOf(large, 512, 65_536)).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    // Under the bound, the browser does get it.
    await decodeForPdf(fixture('photo.webp'), 0).catch(() => {});
    expect(decode).toHaveBeenCalledOnce();
});
