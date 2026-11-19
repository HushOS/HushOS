/*
 * An image's size from its header, read before anything decodes it, so a small file that would
 * decode to more pixels than the PDF tools allow (a decompression bomb) is refused without the
 * browser ever allocating them. PNG (IHDR), JPEG (the frame header), WebP (VP8, VP8L, VP8X), GIF
 * (the logical screen), BMP (the info header) and HEIF/AVIF (the largest `ispe` box). Null when
 * the header can't be read: the caller refuses such a file rather than decode it blind. Pure; it
 * runs in the PDF tools worker.
 */

export type Size = { width: number; height: number };

const ascii = (bytes: Uint8Array, at: number, text: string) => {
    if (at + text.length > bytes.length) return false;
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
    return true;
};

/* Where `heif` and `avif` keep their sizes: an image spatial extents box, within the first MiB. */
const ISPE_WINDOW = 1024 * 1024;

export function imageSize(bytes: Uint8Array): Size | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const valid = (width: number, height: number) =>
        width > 0 && height > 0 ? { width, height } : null;
    // PNG: the signature, then IHDR's width and height.
    if (ascii(bytes, 1, 'PNG') && ascii(bytes, 12, 'IHDR') && bytes.length >= 24)
        return valid(view.getUint32(16), view.getUint32(20));
    // GIF: the logical screen, little-endian.
    if ((ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) && bytes.length >= 10)
        return valid(view.getUint16(6, true), view.getUint16(8, true));
    // BMP: the info header's width and height (a negative height is a top-down bitmap).
    if (ascii(bytes, 0, 'BM') && bytes.length >= 26) {
        const header = view.getUint32(14, true);
        if (header === 12) return valid(view.getUint16(18, true), view.getUint16(20, true));
        return valid(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
    }
    // WebP: a RIFF of one VP8, VP8L or VP8X chunk first.
    if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP') && bytes.length >= 30) {
        if (ascii(bytes, 12, 'VP8X'))
            return valid(
                1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
                1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
            );
        if (ascii(bytes, 12, 'VP8L') && bytes[20] === 0x2f) {
            const bits = view.getUint32(21, true);
            return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        if (ascii(bytes, 12, 'VP8 '))
            return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
        return null;
    }
    // JPEG: the first frame header, walked segment by segment.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2;
        while (at + 4 <= bytes.length) {
            if (bytes[at] !== 0xff) return null;
            const marker = bytes[at + 1]!;
            if (marker === 0xff) {
                at++;
                continue;
            }
            const length = view.getUint16(at + 2);
            const frame =
                marker >= 0xc0 &&
                marker <= 0xcf &&
                marker !== 0xc4 &&
                marker !== 0xc8 &&
                marker !== 0xcc;
            if (frame && at + 9 <= bytes.length)
                return valid(view.getUint16(at + 7), view.getUint16(at + 5));
            if (marker === 0xda || length < 2) return null;
            at += 2 + length;
        }
        return null;
    }
    // HEIF and AVIF: `ftyp`, then the largest `ispe` in the meta box (a grid's, not a tile's).
    if (ascii(bytes, 4, 'ftyp')) {
        let largest: Size | null = null;
        const end = Math.min(bytes.length, ISPE_WINDOW) - 16;
        for (let at = 0; at <= end; at++) {
            if (!ascii(bytes, at, 'ispe')) continue;
            const size = valid(view.getUint32(at + 8), view.getUint32(at + 12));
            if (size && (!largest || size.width * size.height > largest.width * largest.height))
                largest = size;
        }
        return largest;
    }
    return null;
}
