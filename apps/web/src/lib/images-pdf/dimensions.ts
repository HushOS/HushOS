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
    // HEIF and AVIF: the primary item's spatial extents, found by walking the boxes.
    if (ascii(bytes, 4, 'ftyp')) return heifSize(bytes, view);
    return null;
}

type Box = { type: string; start: number; end: number };

/* The boxes between `start` and `end`, each by its own size (32-bit, 64-bit, or to the end). */
function boxes(bytes: Uint8Array, view: DataView, start: number, end: number): Box[] | null {
    const out: Box[] = [];
    for (let at = start; at < end;) {
        if (at + 8 > end) return null;
        let size = view.getUint32(at);
        let header = 8;
        if (size === 1) {
            if (at + 16 > end) return null;
            size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
            header = 16;
        } else if (size === 0) size = end - at;
        if (size < header || at + size > end) return null;
        out.push({
            type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
            start: at + header,
            end: at + size,
        });
        at += size;
    }
    return out;
}

/*
 * HEIF's size: `meta` (a full box) holds `pitm` (the primary item), and `iprp` holds `ipco` (the
 * properties, numbered from 1) and `ipma` (which properties each item has). The primary item's
 * `ispe` is its width and height. Null when any of it is missing or out of place.
 */
function heifSize(bytes: Uint8Array, view: DataView): Size | null {
    const top = boxes(bytes, view, 0, bytes.length);
    const meta = top?.find((box) => box.type === 'meta');
    if (!meta) return null;
    const inner = boxes(bytes, view, meta.start + 4, meta.end);
    const pitm = inner?.find((box) => box.type === 'pitm');
    const iprp = inner?.find((box) => box.type === 'iprp');
    if (!pitm || !iprp) return null;
    const pitmVersion = bytes[pitm.start]!;
    const primary =
        pitmVersion === 0 ? view.getUint16(pitm.start + 4) : view.getUint32(pitm.start + 4);
    const parts = boxes(bytes, view, iprp.start, iprp.end);
    const ipco = parts?.find((box) => box.type === 'ipco');
    const ipma = parts?.find((box) => box.type === 'ipma');
    if (!ipco || !ipma) return null;
    const properties = boxes(bytes, view, ipco.start, ipco.end);
    if (!properties) return null;
    const version = bytes[ipma.start]!;
    const wide = (bytes[ipma.start + 3]! & 1) === 1;
    let at = ipma.start + 4;
    const entries = view.getUint32(at);
    at += 4;
    for (let entry = 0; entry < entries; entry++) {
        if (at + (version < 1 ? 3 : 5) > ipma.end) return null;
        const item = version < 1 ? view.getUint16(at) : view.getUint32(at);
        at += version < 1 ? 2 : 4;
        const count = bytes[at]!;
        at += 1;
        for (let i = 0; i < count; i++) {
            if (at + (wide ? 2 : 1) > ipma.end) return null;
            const index = wide ? view.getUint16(at) & 0x7fff : bytes[at]! & 0x7f;
            at += wide ? 2 : 1;
            if (item !== primary) continue;
            const property = properties[index - 1];
            if (property?.type === 'ispe' && property.start + 12 <= property.end)
                return valid(
                    view.getUint32(property.start + 4),
                    view.getUint32(property.start + 8),
                );
        }
    }
    return null;
}

function valid(width: number, height: number) {
    return width > 0 && height > 0 ? { width, height } : null;
}
