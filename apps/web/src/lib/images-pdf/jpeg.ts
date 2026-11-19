/*
 * The JPEG segment cutter (docs/file-tools-design.md, feature (b)): what a picture needs, and
 * nothing that says where or with what it was taken. A PDF reader shows no image metadata, so
 * a location riding along inside a PDF would be invisible to the person who shares it.
 *
 * It walks every segment, between the scans of a progressive JPEG too, and keeps the frame
 * header, the tables, the restart interval and the scans, plus three application segments:
 * APP0 `JFIF`, APP2 `ICC_PROFILE` (the colour profile) and APP14 `Adobe` (how CMYK is stored).
 * Every other application segment (EXIF, XMP, IPTC, MPF, makers' own) and every comment is cut,
 * and so is anything after the end of the image (a second picture, as MPF files carry). The
 * scans are copied unchanged, so the picture is the same to the bit.
 *
 * The orientation the first EXIF block names is read before it goes, so the page can turn the
 * picture instead of re-encoding it.
 *
 * Its twin is `cut_jpeg` in crates/hushos-core/src/images_pdf.rs; both are held to
 * e2e/fixtures/images/expected.json, whose expected outputs make.py works out on its own. Pure
 * and dependency-free: it runs in the PDF tools worker.
 */

export type JpegRefusal = 'damaged' | 'unsupported';

export class JpegRefused extends Error {
    constructor(readonly code: JpegRefusal) {
        super(code);
        this.name = 'JpegRefused';
    }
}

export type CutJpeg = {
    bytes: Uint8Array;
    /* As stored, before the orientation. */
    width: number;
    height: number;
    /* 1 (grey), 3 (colour) or 4 (CMYK). */
    components: 1 | 3 | 4;
    /* The EXIF orientation, 1 to 8; 1 when there is none or it can't be read. */
    orientation: number;
    /* An APP14 Adobe segment was kept. */
    adobe: boolean;
};

const startsWith = (bytes: Uint8Array, prefix: string) => {
    if (bytes.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix.charCodeAt(i)) return false;
    return true;
};

/* What is kept of an application segment or comment, by marker and identifier. */
function keeps(marker: number, payload: Uint8Array) {
    if (marker === 0xe0) return startsWith(payload, 'JFIF\0');
    if (marker === 0xe2) return startsWith(payload, 'ICC_PROFILE\0');
    if (marker === 0xee) return startsWith(payload, 'Adobe');
    return false;
}

/* The orientation an EXIF block's first image directory gives, if it gives one that makes sense. */
export function exifOrientation(tiff: Uint8Array): number | null {
    if (tiff.length < 8) return null;
    let little: boolean;
    if (tiff[0] === 0x49 && tiff[1] === 0x49) little = true;
    else if (tiff[0] === 0x4d && tiff[1] === 0x4d) little = false;
    else return null;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const u16 = (at: number) => (at + 2 <= tiff.length ? view.getUint16(at, little) : null);
    const u32 = (at: number) => (at + 4 <= tiff.length ? view.getUint32(at, little) : null);
    if (u16(2) !== 42) return null;
    const directory = u32(4);
    if (directory === null) return null;
    const entries = u16(directory);
    if (entries === null) return null;
    for (let index = 0; index < entries; index++) {
        const entry = directory + 2 + index * 12;
        const tag = u16(entry);
        if (tag === null) return null;
        if (tag !== 0x0112) continue;
        // SHORT, one value, held in the entry itself.
        if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null;
        const value = u16(entry + 8);
        return value !== null && value >= 1 && value <= 8 ? value : null;
    }
    return null;
}

/* Grows as segments are kept: never larger than the input plus an end marker. */
class Out {
    bytes: Uint8Array;
    length = 0;
    constructor(capacity: number) {
        this.bytes = new Uint8Array(capacity);
    }
    push(part: Uint8Array) {
        this.bytes.set(part, this.length);
        this.length += part.length;
    }
    pushBytes(...values: number[]) {
        for (const value of values) this.bytes[this.length++] = value;
    }
}

/* Cuts a JPEG's metadata without touching its picture; throws JpegRefused. */
export function cutJpeg(input: Uint8Array): CutJpeg {
    const damaged = () => new JpegRefused('damaged');
    const unsupported = () => new JpegRefused('unsupported');
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw damaged();
    const out = new Out(input.length + 2);
    out.pushBytes(0xff, 0xd8);
    let pos = 2;
    let frame: { width: number; height: number; components: 1 | 3 | 4 } | null = null;
    // undefined: no EXIF block met yet; null: the first one named no orientation.
    let orientation: number | null | undefined;
    let adobe = false;
    let scanned = false;
    // The cut JPEG, ended with its end-of-image marker (one the file stopped short of is added).
    const ended = (): CutJpeg => {
        out.pushBytes(0xff, 0xd9);
        if (!frame) throw damaged();
        return {
            bytes: out.bytes.subarray(0, out.length),
            width: frame.width,
            height: frame.height,
            components: frame.components,
            orientation: orientation ?? 1,
            adobe,
        };
    };
    for (;;) {
        // Between segments: a marker, after any number of fill bytes. A file that stops here
        // after a scan keeps what is there.
        if (pos >= input.length) {
            if (scanned) return ended();
            throw damaged();
        }
        if (input[pos] !== 0xff) throw damaged();
        while (pos < input.length && input[pos] === 0xff) pos++;
        if (pos >= input.length) {
            if (scanned) return ended();
            throw damaged();
        }
        const marker = input[pos]!;
        pos++;
        if (marker === 0xd9) {
            // The end of the image; anything after it (a second picture) is cut.
            if (scanned) return ended();
            throw damaged();
        }
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8))
            throw damaged();
        if (pos + 2 > input.length) throw damaged();
        const length = (input[pos]! << 8) | input[pos + 1]!;
        if (length < 2 || pos + length > input.length) throw damaged();
        const payload = input.subarray(pos + 2, pos + length);
        const segmentEnd = pos + length;
        let keep: boolean;
        if (marker >= 0xc0 && marker <= 0xc2) {
            if (frame || payload.length < 6) throw damaged();
            const precision = payload[0]!;
            const height = (payload[1]! << 8) | payload[2]!;
            const width = (payload[3]! << 8) | payload[4]!;
            const components = payload[5]!;
            if (payload.length < 6 + 3 * components) throw damaged();
            if (
                precision !== 8 ||
                (components !== 1 && components !== 3 && components !== 4) ||
                height === 0
            )
                throw unsupported();
            if (width === 0) throw damaged();
            frame = { width, height, components };
            keep = true;
        } else if (
            // Lossless, hierarchical, arithmetic coding and their tables, and markers set apart
            // for extensions: real JPEGs, but not ones a PDF reader can be counted on to show.
            marker === 0xc3 ||
            (marker >= 0xc5 && marker <= 0xcf) ||
            marker === 0xdc ||
            marker === 0xde ||
            marker === 0xdf ||
            (marker >= 0xf0 && marker <= 0xfd)
        ) {
            throw unsupported();
        } else if (marker === 0xc4 || marker === 0xdb || marker === 0xdd) {
            keep = true;
        } else if (marker === 0xda) {
            if (!frame) throw damaged();
            keep = true;
        } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
            if (marker === 0xe1 && orientation === undefined && startsWith(payload, 'Exif\0\0')) {
                // The first EXIF block decides, as browsers decide; a broken one says upright.
                orientation = exifOrientation(payload.subarray(6));
            }
            keep = keeps(marker, payload);
            if (keep && marker === 0xee) adobe = true;
        } else {
            throw damaged();
        }
        if (keep) {
            out.pushBytes(0xff, marker);
            out.push(input.subarray(pos, segmentEnd));
        }
        pos = segmentEnd;
        if (marker !== 0xda) continue;
        // The scan's data, copied as it is up to the next marker: stuffed zeros and restart
        // markers are part of it; a fill byte before a marker is not.
        scanned = true;
        for (;;) {
            const found = input.indexOf(0xff, pos);
            if (found < 0) {
                out.push(input.subarray(pos));
                return ended();
            }
            out.push(input.subarray(pos, found));
            pos = found;
            if (pos + 1 >= input.length) return ended();
            const next = input[pos + 1]!;
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
                out.push(input.subarray(pos, pos + 2));
                pos += 2;
            } else if (next === 0xff) {
                pos += 1;
            } else break;
        }
    }
}
