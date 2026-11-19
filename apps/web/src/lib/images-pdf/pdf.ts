import {
    concatTransformationMatrix,
    drawObject,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    popGraphicsState,
    pushGraphicsState,
} from '@cantoo/pdf-lib';
import { cutJpeg, JpegRefused } from './jpeg';
import { pageLayout, type PageSize } from './geometry';
import { MAX_PIXELS, PDF_MAX_BYTES } from './protocol';

export { MAX_PIXELS, PDF_MAX_BYTES };

/*
 * One PDF, an image a page, built with @cantoo/pdf-lib in the PDF tools worker
 * (docs/file-tools-design.md, feature (b)). No document information dictionary: pdf-lib's own
 * Producer, Creator and dates are left out with the images' metadata.
 *
 * - A JPEG goes in as a DCTDecode stream of its bytes as they are, its metadata cut (jpeg.ts),
 *   its EXIF orientation applied by the page's matrix. Its image dictionary is written here, the
 *   same as the core's writer writes it (crates/hushos-core/src/images_pdf.rs), not by pdf-lib's
 *   own embedder, which reads the frame header with a looser parse of its own.
 * - A PNG goes in through pdf-lib's embedder: its pixels, transparency as a soft mask, nothing
 *   of its text or EXIF chunks.
 * - Anything else was decoded and encoded again by the worker (decode.ts) and comes here as one
 *   of those two.
 */

/* A refusal of one image, by its place in the order: `damaged:2`. The page puts it into words. */
export class ImageRefused extends Error {
    constructor(
        readonly reason:
            | 'damaged'
            | 'unsupported'
            | 'heic'
            | 'too-many-pixels'
            | 'too-large-to-decode',
        readonly index: number,
    ) {
        super(`${reason}:${index}`);
        this.name = 'ImageRefused';
    }
}

export type Kind = 'jpeg' | 'png' | 'other';

/* What the bytes are, by their signature, never by the name: JPEG and PNG go in as they are. */
export function sniff(bytes: Uint8Array): Kind {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((value, i) => bytes[i] === value)) return 'png';
    return 'other';
}

/* An HEIF file with HEVC pictures (an iPhone photo), by its file type box. */
export function isHeic(bytes: Uint8Array) {
    if (bytes.length < 12) return false;
    const box = String.fromCharCode(...bytes.subarray(4, 12));
    return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(box);
}

export type PdfOptions = { size: PageSize; margin: boolean };

export class ImagesPdf {
    /* Bytes of image streams so far: a PDF bound to pass PDF_MAX_BYTES is refused before it is saved. */
    #streamed = 0;
    private constructor(
        readonly doc: PDFDocument,
        readonly options: PdfOptions,
    ) {}

    static async create(options: PdfOptions) {
        return new ImagesPdf(await PDFDocument.create({ updateMetadata: false }), options);
    }

    get pages() {
        return this.doc.getPageCount();
    }

    #grow(bytes: number) {
        this.#streamed += bytes;
        if (this.#streamed > PDF_MAX_BYTES) throw new PdfTooLarge();
    }

    #page(ref: PDFRef, w: number, h: number, o: number) {
        const layout = pageLayout(w, h, o, this.options.size, this.options.margin);
        const page = this.doc.addPage([layout.width, layout.height]);
        const name = page.node.newXObject('Im', ref);
        page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(...layout.matrix),
            drawObject(name),
            popGraphicsState(),
        );
    }

    /* A JPEG, its metadata cut and its orientation applied on the page. */
    addJpeg(bytes: Uint8Array, index: number) {
        let cut;
        try {
            cut = cutJpeg(bytes);
        } catch (error) {
            if (error instanceof JpegRefused) throw new ImageRefused(error.code, index);
            throw error;
        }
        this.#grow(cut.bytes.byteLength);
        const context = this.doc.context;
        const stream = context.stream(cut.bytes, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: cut.width,
            Height: cut.height,
            ColorSpace:
                cut.components === 1
                    ? 'DeviceGray'
                    : cut.components === 4
                      ? 'DeviceCMYK'
                      : 'DeviceRGB',
            BitsPerComponent: 8,
            Filter: 'DCTDecode',
            // Adobe's CMYK is stored complemented (its APP14 says so): turned back here. Plain CMYK is not.
            ...(cut.components === 4 && cut.adobe ? { Decode: [1, 0, 1, 0, 1, 0, 1, 0] } : {}),
        });
        this.#page(context.register(stream), cut.width, cut.height, cut.orientation);
        return cut;
    }

    /* A PNG's pixels, transparency included; embedded at once, so its decoded pixels go now. */
    async addPng(bytes: Uint8Array, index: number) {
        const size = pngSize(bytes);
        if (!size) throw new ImageRefused('damaged', index);
        if (size.width * size.height > MAX_PIXELS) throw new ImageRefused('too-many-pixels', index);
        let image;
        try {
            image = await this.doc.embedPng(bytes);
            await image.embed();
        } catch {
            throw new ImageRefused('damaged', index);
        }
        // Counted by what pdf-lib wrote, its pixels and their soft mask compressed again: a PNG's own
        // size bounds neither (a palette or a filter expands), so the PDF stops growing here, never at save.
        this.#grow(this.#streamBytes(image.ref));
        this.#page(image.ref, image.width, image.height, 1);
    }

    /* An image stream's bytes and its soft mask's, as written into the document. */
    #streamBytes(ref: PDFRef) {
        const context = this.doc.context;
        const size = (object: unknown) =>
            object instanceof PDFRawStream ? object.getContentsSize() : 0;
        const image = context.lookup(ref);
        const mask =
            image instanceof PDFRawStream ? image.dict.get(PDFName.of('SMask')) : undefined;
        return size(image) + (mask instanceof PDFRef ? size(context.lookup(mask)) : 0);
    }

    async save() {
        const pdf = await this.doc.save({ useObjectStreams: false, addDefaultPage: false });
        if (pdf.byteLength > PDF_MAX_BYTES) throw new PdfTooLarge();
        return pdf;
    }
}

export class PdfTooLarge extends Error {
    constructor() {
        super('too-large');
        this.name = 'PdfTooLarge';
    }
}

/* A PNG's size from its header chunk, or null when it doesn't start like one. */
export function pngSize(bytes: Uint8Array) {
    if (bytes.length < 24 || sniff(bytes) !== 'png') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
}
