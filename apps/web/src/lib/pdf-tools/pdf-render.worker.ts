import type * as Pdfjs from 'pdfjs-dist';
import { pdfAssetOptions } from '@/lib/viewers/pdf-assets';
import { serveTool, ToolError, type RangeSource } from '@/lib/tools/worker';
import { THUMBNAIL } from '@/lib/images-pdf/protocol';
import { IMAGES_MAX_PIXELS, type RenderInput, type RenderSummary } from './protocol';

/*
 * Save as images (docs/file-tools-design.md, feature (c)): each planned page rendered by pdf.js and
 * encoded as PNG or JPEG, handed back one at a time under the tool harness (the watchdog, the
 * budget, cancel by terminate). pdf.js keeps its own worker, which this one starts as the thumbnail
 * worker does, so this is a module worker under the app's policy rather than a tools worker: pdf.js
 * fetches its decoders, fonts and CMaps from this origin (lib/viewers/pdf-assets.ts), never anything
 * a PDF names. It holds no keys and reads its sources only through the page.
 *
 * One page bitmap at a time (section 3, "Memory"). A page past IMAGES_MAX_PIXELS at the chosen
 * resolution is refused as `too-many-pixels:<index>` before it is drawn. The canvas's encoder hands
 * back a Blob, read at once into the result; it is no larger than the image, the exposure One PDF's
 * decoder already has (decode.ts).
 */

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

/* The page drawn at most `edge` on its longest side, as WebP within `maxBytes`, or null. */
async function thumbnailOf(source: OffscreenCanvas, edge: number, maxBytes: number) {
    const scale = Math.min(1, edge / Math.max(source.width, source.height));
    const small = new OffscreenCanvas(
        Math.max(1, Math.round(source.width * scale)),
        Math.max(1, Math.round(source.height * scale)),
    );
    const context = small.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, small.width, small.height);
    for (const quality of [0.82, 0.7, 0.58]) {
        const blob = await small.convertToBlob({ type: 'image/webp', quality });
        if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
    }
    return null;
}

/* pdf.js's own canvases, made as OffscreenCanvases: its default factory asks a document for them. */
class OffscreenCanvasFactory {
    constructor(_options: unknown) {}
    create(width: number, height: number) {
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
    }
    reset(target: { canvas: OffscreenCanvas | null }, width: number, height: number) {
        if (!target.canvas) throw new Error('Canvas is not specified');
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        target.canvas.width = width;
        target.canvas.height = height;
    }
    destroy(target: { canvas: OffscreenCanvas | null; context: unknown }) {
        if (!target.canvas) throw new Error('Canvas is not specified');
        target.canvas.width = 0;
        target.canvas.height = 0;
        target.canvas = null;
        target.context = null;
    }
    getNoAlphaContext(canvas: OffscreenCanvas) {
        return canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
}

let pdfjsModule: Promise<typeof Pdfjs> | null = null;
function loadPdfjs() {
    pdfjsModule ??= Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
        /*
         * pdf.js's own worker, started here and handed to it as its port. Left to start one itself,
         * pdf.js looks for `window`, finds none in a worker, and falls back to running its worker
         * code on this thread, which then answers this worker's own messages: the run's protocol
         * would hear pdf.js and fail. Terminating this worker ends that one with it.
         */
        pdfjs.GlobalWorkerOptions.workerPort = new Worker(worker.default, {
            type: 'module',
            name: 'pdf.js',
        });
        return pdfjs;
    });
    return pdfjsModule;
}

serveTool<RenderInput, RenderSummary>(async (input, context) => {
    const pdfjs = await loadPdfjs();
    const total = input.pages.length + context.sources.length;
    let done = 0;
    const documents: Pdfjs.PDFDocumentProxy[] = [];
    const tasks: Pdfjs.PDFDocumentLoadingTask[] = [];
    try {
        for (const source of context.sources) {
            const bytes = await readWhole(source, () => context.progress(done, total));
            source.close?.();
            const task = pdfjs.getDocument({
                // pdf.js moves the buffer to its own worker.
                data: bytes,
                ...pdfAssetOptions(self.location.origin),
                useWorkerFetch: true,
                stopAtErrors: false,
                // Canvases pdf.js makes for itself (a transparency group, a mask): this worker has no document.
                CanvasFactory: OffscreenCanvasFactory,
            });
            tasks.push(task);
            try {
                documents.push(await task.promise);
            } catch {
                throw new ToolError(`damaged:${documents.length}`);
            }
            context.progress(++done, total);
        }
        for (const [index, planned] of input.pages.entries()) {
            const document = documents[planned.source];
            if (!document || planned.page < 0 || planned.page >= document.numPages)
                throw new ToolError(`damaged:${planned.source}`);
            const page = await document.getPage(planned.page + 1);
            // The canvas is the viewport drawn into, /UserUnit and rotation included, rounded as every
            // client rounds (imageSize): checked against the pixel cap before a pixel is allocated.
            const viewport = page.getViewport({ scale: input.dpi / 72, rotation: planned.rotate });
            const size = {
                width: Math.max(1, Math.round(viewport.width)),
                height: Math.max(1, Math.round(viewport.height)),
            };
            if (!(size.width * size.height <= IMAGES_MAX_PIXELS))
                throw new ToolError(`too-many-pixels:${index}`);
            const canvas = new OffscreenCanvas(size.width, size.height);
            await page.render({
                canvas: canvas as unknown as HTMLCanvasElement,
                viewport,
                background: 'rgb(255,255,255)',
            }).promise;
            page.cleanup();
            // Its thumbnail first, as One PDF hands one back: the page drawn small, if it fits.
            const thumbnail = await thumbnailOf(
                canvas,
                input.thumbnail.edge,
                input.thumbnail.maxBytes,
            );
            if (thumbnail) await context.produce(THUMBNAIL, thumbnail, 'image/webp');
            const blob = await canvas.convertToBlob(
                input.format === 'png'
                    ? { type: 'image/png' }
                    : { type: 'image/jpeg', quality: 0.92 },
            );
            // The bitmap goes before the next page is drawn.
            canvas.width = 0;
            canvas.height = 0;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            context.progress(++done, total);
            await context.produce(
                input.names[index] ?? `page ${index + 1}`,
                bytes,
                input.format === 'png' ? 'image/png' : 'image/jpeg',
            );
        }
        return { images: input.pages.length };
    } finally {
        for (const task of tasks) void task.destroy();
    }
});
