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
    // HEIF: the primary item's ispe, found through meta, pitm, iprp, ipco and ipma, not a text
    // search: a decoy "ispe" in the media data first, and a tile's ispe beside the primary's.
    const box = (type: string, ...parts: (Uint8Array | number[])[]) => {
        const body = parts.flatMap((part) => [...part]);
        const out = new Uint8Array(8 + body.length);
        new DataView(out.buffer).setUint32(0, out.length);
        out.set(new TextEncoder().encode(type), 4);
        out.set(body, 8);
        return out;
    };
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const ispe = (w: number, h: number) => box('ispe', [0, 0, 0, 0], u32(w), u32(h));
    const heif = (decoy: boolean, primary: number) =>
        new Uint8Array([
            ...box('ftyp', new TextEncoder().encode('heic'), [0, 0, 0, 0]),
            ...(decoy
                ? box(
                      'mdat',
                      new TextEncoder().encode('ispe'),
                      [0, 0, 0, 0],
                      u32(90_000),
                      u32(90_000),
                  )
                : []),
            ...box(
                'meta',
                [0, 0, 0, 0],
                box('pitm', [0, 0, 0, 0], [0, primary]),
                box(
                    'iprp',
                    box('ipco', ispe(512, 512), ispe(4032, 3024)),
                    // Item 1 has property 1 (the tile's size), item 2 property 2.
                    box('ipma', [0, 0, 0, 0], u32(2), [0, 1, 1, 0x81], [0, 2, 1, 0x82]),
                ),
            ),
        ]);
    expect(imageSize(heif(true, 2))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(heif(false, 1))).toEqual({ width: 512, height: 512 });
    expect(imageSize(heif(false, 3))).toBeNull();
    // A pitm cut short inside its box: null, never a read into its neighbour or a thrown RangeError.
    const truncated = heif(false, 2);
    const at = truncated.findIndex(
        (_, i) => String.fromCharCode(...truncated.subarray(i, i + 4)) === 'pitm',
    );
    new DataView(truncated.buffer).setUint32(at - 4, 12);
    expect(() => imageSize(truncated)).not.toThrow();
    expect(imageSize(truncated)).toBeNull();
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
