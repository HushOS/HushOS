import { serveTool, ToolError, type RangeSource } from '@/lib/tools/worker';
import { decodeForPdf, thumbnailOf } from './decode';
import { ImageRefused, ImagesPdf, PdfTooLarge, sniff } from './pdf';
import { THUMBNAIL, type ImagesPdfInput, type ImagesPdfSummary } from './protocol';

/*
 * The PDF tools worker for One PDF (docs/file-tools-design.md, feature (b)): reads each image
 * through the page, in the order chosen, and builds the PDF with @cantoo/pdf-lib. A tools
 * worker: its file is `*.tool-worker.ts`, so it runs under a policy that names no source (no
 * fetch, no import, no worker of its own), bundled as one file, pdf-lib inside, holding no keys.
 *
 * It hands back two results at most: a thumbnail of the first image (THUMBNAIL), then the PDF.
 * A refusal is a code the page puts into words: `<reason>:<index>` for one image, `too-large`
 * for the whole PDF.
 */

/* Each read at most this much, so progress comes as the file arrives and the watchdog hears of it. */
const PIECE = 8 * 1024 * 1024;

async function readWhole(source: RangeSource, onPiece: () => void) {
    const bytes = new Uint8Array(source.size);
    for (let offset = 0; offset < source.size;) {
        const piece = await source.read(offset, Math.min(PIECE, source.size - offset));
        if (piece.byteLength === 0) throw new ToolError('damaged');
        bytes.set(piece, offset);
        offset += piece.byteLength;
        onPiece();
    }
    return bytes;
}

serveTool<ImagesPdfInput, ImagesPdfSummary>(async (input, context) => {
    const total = context.sources.length;
    const pdf = await ImagesPdf.create({ size: input.size, margin: input.margin });
    let thumbnail: Uint8Array | null = null;
    try {
        for (const [index, source] of context.sources.entries()) {
            let bytes: Uint8Array | null = await readWhole(source, () =>
                context.progress(index, total + 1),
            );
            // Read whole: its reader goes now, its chunks and key with it.
            source.close?.();
            if (index === 0)
                thumbnail = await thumbnailOf(
                    bytes,
                    input.thumbnail.edge,
                    input.thumbnail.maxBytes,
                );
            const kind = sniff(bytes);
            if (kind === 'other') {
                const encoded = await decodeForPdf(bytes, index);
                bytes = encoded.bytes;
                if (encoded.kind === 'png') await pdf.addPng(bytes, index);
                else pdf.addJpeg(bytes, index);
            } else if (kind === 'png') await pdf.addPng(bytes, index);
            else pdf.addJpeg(bytes, index);
            bytes = null;
            context.progress(index + 1, total + 1);
        }
        const made = await pdf.save();
        context.progress(total, total + 1);
        if (thumbnail) await context.produce(THUMBNAIL, thumbnail, 'image/jpeg');
        await context.produce(input.name, made, 'application/pdf');
        context.progress(total + 1, total + 1);
        return { pages: pdf.pages };
    } catch (error) {
        if (error instanceof ImageRefused) throw new ToolError(error.message);
        if (error instanceof PdfTooLarge) throw new ToolError('too-large');
        throw error;
    }
});
