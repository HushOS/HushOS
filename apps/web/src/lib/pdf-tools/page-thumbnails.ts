import type { DriveNode } from '@hushos/drive/client';
import type * as Pdfjs from 'pdfjs-dist';
import { downloads } from '@/lib/drive/transfers/downloads';
import { pdfAssetOptions, pdfAssetsReady } from '@/lib/viewers/pdf-assets';
import type { Rotation } from './protocol';

/*
 * The Edit pages dialog's thumbnails: each PDF opened with pdf.js as the viewer opens a large one,
 * fed by range from the download engine's reader (only the ranges pdf.js asks for are fetched and
 * decrypted), drawn into the dialog's own canvases. No Blob, no blob URL: a page is pixels on a
 * canvas until the dialog closes. The PDFs' structure (pages, warnings, refusals) is the PDF tools
 * worker's to say (make.ts, inspectPdfs); pdf.js only draws.
 *
 * A range that fails to arrive fails the drawer: pdf.js would otherwise wait for it for ever (its
 * transport's abort does nothing), and a save waiting on a thumbnail would wait with it. The loading
 * task is destroyed and the reader closed, and every draw waiting on the document fails too.
 */

let pdfjsModule: Promise<typeof Pdfjs> | null = null;
function loadPdfjs() {
    pdfjsModule ??= Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
    });
    return pdfjsModule;
}

/* A draw under way: its end, and a way to stop it (the canvas is free again once it settles). */
export type Drawing = { promise: Promise<void>; cancel(): void };

export type PageDrawer = {
    /* Draws page `page` (from 0) turned to `rotate`, at most `edge` pixels on its longest side. */
    draw(page: number, rotate: Rotation, edge: number, canvas: HTMLCanvasElement): Drawing;
    /* The same page as a small WebP within `maxBytes` (a saved file's thumbnail), or null. */
    thumbnail(
        page: number,
        rotate: Rotation,
        edge: number,
        maxBytes: number,
    ): Promise<Uint8Array | null>;
    close(): void;
};

type Reader = {
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): unknown;
};

/* What a drawer is opened with: pdf.js, the file's reader, and pdf.js's assets. Replaced in tests. */
export type DrawerDeps = {
    load: () => Promise<typeof Pdfjs>;
    open: (node: DriveNode) => Reader;
    ready: () => Promise<void>;
};

const defaults: DrawerDeps = {
    load: loadPdfjs,
    open: (node) => downloads.openReader(node),
    ready: pdfAssetsReady,
};

export async function openPageDrawer(
    node: DriveNode,
    deps: DrawerDeps = defaults,
): Promise<PageDrawer> {
    const [pdfjs] = await Promise.all([deps.load(), deps.ready()]);
    const reader = deps.open(node);
    let fail!: (error: unknown) => void;
    // Settles only when a range fails: everything waiting on the document races it.
    const failed = new Promise<never>((_, reject) => (fail = reject));
    failed.catch(() => {});
    let ended = false;
    let task: Pdfjs.PDFDocumentLoadingTask | null = null;
    const end = () => {
        if (ended) return;
        ended = true;
        void task?.destroy();
        void Promise.resolve(reader.close()).catch(() => {});
    };
    class ReaderTransport extends pdfjs.PDFDataRangeTransport {
        requestDataRange(begin: number, end_: number) {
            reader
                .read(begin, end_ - begin)
                .then((chunk) => this.onDataRange(begin, chunk))
                .catch((error: unknown) => {
                    fail(error);
                    end();
                });
        }
    }
    task = pdfjs.getDocument({
        ...pdfAssetOptions(window.location.origin),
        range: new ReaderTransport(reader.size, null),
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
    });
    // A PDF with a user password asks; the worker refuses it anyway, so the drawer gives up.
    task.onPassword = () => {
        fail(new Error('This PDF has a password.'));
        end();
    };
    let document: Pdfjs.PDFDocumentProxy;
    try {
        document = await Promise.race([task.promise, failed]);
    } catch (error) {
        end();
        throw error;
    }
    function render(
        page: number,
        rotate: Rotation,
        edge: number,
        canvas: HTMLCanvasElement | OffscreenCanvas,
    ): Drawing {
        let rendering: Pdfjs.RenderTask | null = null;
        let stopped = false;
        const promise = (async () => {
            const proxy = await Promise.race([document.getPage(page + 1), failed]);
            if (stopped) throw new Error('Stopped.');
            const base = proxy.getViewport({ scale: 1, rotation: rotate });
            const scale = edge / Math.max(base.width, base.height);
            const viewport = proxy.getViewport({ scale, rotation: rotate });
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            rendering = proxy.render({ canvas: canvas as HTMLCanvasElement, viewport });
            await Promise.race([rendering.promise, failed]);
        })();
        return {
            promise,
            cancel() {
                stopped = true;
                rendering?.cancel();
            },
        };
    }
    return {
        draw: (page, rotate, edge, canvas) => render(page, rotate, edge, canvas),
        async thumbnail(page, rotate, edge, maxBytes) {
            if (typeof OffscreenCanvas === 'undefined') return null;
            try {
                const canvas = new OffscreenCanvas(1, 1);
                await render(page, rotate, edge, canvas).promise;
                for (const quality of [0.82, 0.7, 0.58]) {
                    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
                    if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
                }
            } catch {
                // A page pdf.js can't draw saves without a thumbnail.
            }
            return null;
        },
        close: end,
    };
}
