import { Unzlib } from 'fflate';
import { exifOrientation } from './jpeg';

/*
 * A PNG made safe for pdf-lib's decoder before it sees it (docs/file-tools-design.md, feature (b)).
 * pdf-lib decodes every frame of an animated PNG and inflates text chunks the PDF never uses, so a
 * small file could take the tab's memory. Here, first:
 *
 * - an animated PNG (an `acTL` chunk) is refused: its frames would be decoded, not shown;
 * - the image data is inflated once through a counter and refused as soon as it passes what its
 *   header says it holds (each row and its filter byte, every pass of an interlaced image): a zlib
 *   bomb costs a few hundred KiB, never its claimed size;
 * - every chunk the picture doesn't need goes (text, time, EXIF, the colour profile and the rest),
 *   keeping IHDR, PLTE, tRNS, the image data and IEND;
 * - an `eXIf` chunk's orientation is read first, for the page to turn the picture as the browser does.
 *
 * Pure; it runs in the PDF tools worker.
 */

export type PreparedPng = { png: Uint8Array; width: number; height: number; orientation: number };

export class PngRefused extends Error {
    constructor(readonly reason: 'damaged' | 'animated') {
        super(reason);
        this.name = 'PngRefused';
    }
}

const KEPT = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
/* The bit depths each colour type allows (PNG specification, 11.2.2). */
const DEPTHS: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
};
/* Channels by colour type: grey, RGB, palette, grey and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/* Image data is fed to the inflater this much at a time, so one push never makes more than about a MiB. */
const FEED = 1024;

/* What the image data inflates to, per its header: every row of every pass, with its filter byte. */
export function rawSize(
    width: number,
    height: number,
    depth: number,
    channels: number,
    interlaced: boolean,
) {
    const rowBytes = (w: number) => Math.ceil((w * channels * depth) / 8);
    if (!interlaced) return height * (1 + rowBytes(width));
    // Adam7: each pass's start and step across and down.
    const passes = [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
    ] as const;
    let total = 0;
    for (const [x0, y0, dx, dy] of passes) {
        const w = Math.ceil((width - x0) / dx);
        const h = Math.ceil((height - y0) / dy);
        if (w > 0 && h > 0) total += h * (1 + rowBytes(w));
    }
    return total;
}

export function preparePng(bytes: Uint8Array): PreparedPng {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 8 || signature.some((value, i) => bytes[i] !== value))
        throw new PngRefused('damaged');
    const kept: Uint8Array[] = [bytes.subarray(0, 8)];
    const data: Uint8Array[] = [];
    let header: {
        width: number;
        height: number;
        depth: number;
        type: number;
        interlaced: boolean;
    } | null = null;
    let orientation = 1;
    let palette: number | null = null;
    let ended = false;
    for (let at = 8; at + 12 <= bytes.length && !ended;) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const end = at + 12 + length;
        if (length > 0x7fffffff || end > bytes.length) throw new PngRefused('damaged');
        const body = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            if (header || length < 13) throw new PngRefused('damaged');
            header = {
                width: view.getUint32(at + 8),
                height: view.getUint32(at + 12),
                depth: body[8]!,
                type: body[9]!,
                interlaced: body[12] === 1,
            };
            // Only what the specification allows, before any of it bounds the inflation: a depth too
            // deep for its colour type would let more data through than a real image could hold.
            if (
                header.width === 0 ||
                header.height === 0 ||
                !DEPTHS[header.type]?.includes(header.depth) ||
                body[10] !== 0 ||
                body[11] !== 0 ||
                body[12]! > 1
            )
                throw new PngRefused('damaged');
        } else if (!header) throw new PngRefused('damaged');
        if (type === 'acTL') throw new PngRefused('animated');
        // The palette and its transparency, held to the specification (11.2.3, 11.3.2.1) before pdf-lib
        // turns them into arrays: an oversized one would cost memory however small the picture.
        if (type === 'PLTE') {
            const entries = length / 3;
            if (
                palette !== null ||
                ![2, 3, 6].includes(header.type) ||
                length % 3 !== 0 ||
                entries < 1 ||
                entries > 256 ||
                (header.type === 3 && entries > 2 ** header.depth)
            )
                throw new PngRefused('damaged');
            palette = entries;
        }
        if (type === 'tRNS') {
            const allowed =
                header.type === 0
                    ? length === 2
                    : header.type === 2
                      ? length === 6
                      : header.type === 3 && palette !== null && length <= palette;
            if (!allowed) throw new PngRefused('damaged');
        }
        if (type === 'eXIf') orientation = exifOrientation(body) ?? 1;
        if (type === 'IDAT') data.push(body);
        if (type === 'IEND') ended = true;
        if (KEPT.has(type)) kept.push(bytes.subarray(at, end));
        at = end;
    }
    const channels = header && CHANNELS[header.type];
    if (
        !header ||
        !channels ||
        !ended ||
        data.length === 0 ||
        header.width === 0 ||
        header.height === 0 ||
        (header.type === 3 && palette === null)
    )
        throw new PngRefused('damaged');
    // Inflated once, through a counter: past what the header says it holds, refused at once.
    const most = rawSize(header.width, header.height, header.depth, channels, header.interlaced);
    let made = 0;
    let done = false;
    const inflate = new Unzlib((chunk, final) => {
        made += chunk.length;
        if (made > most) throw new PngRefused('damaged');
        if (final) done = true;
    });
    try {
        for (let i = 0; i < data.length; i++)
            for (let at = 0; at < data[i]!.length; at += FEED)
                inflate.push(data[i]!.subarray(at, at + FEED), false);
        inflate.push(new Uint8Array(0), true);
    } catch (error) {
        if (error instanceof PngRefused) throw error;
        throw new PngRefused('damaged');
    }
    if (!done || made !== most) throw new PngRefused('damaged');
    const png = new Uint8Array(kept.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of kept) {
        png.set(part, offset);
        offset += part.length;
    }
    return { png, width: header.width, height: header.height, orientation };
}
