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

export type PageDrawer = {
    /* Draws page `page` (from 0) turned to `rotate`, at most `edge` pixels on its longest side. */
    draw(page: number, rotate: Rotation, edge: number, canvas: HTMLCanvasElement): Promise<void>;
    /* The same page as a small WebP within `maxBytes` (a saved file's thumbnail), or null. */
    thumbnail(
        page: number,
        rotate: Rotation,
        edge: number,
        maxBytes: number,
    ): Promise<Uint8Array | null>;
    close(): void;
};

export async function openPageDrawer(node: DriveNode): Promise<PageDrawer> {
    const [pdfjs] = await Promise.all([loadPdfjs(), pdfAssetsReady()]);
    const reader = downloads.openReader(node);
    class ReaderTransport extends pdfjs.PDFDataRangeTransport {
        requestDataRange(begin: number, end: number) {
            reader
                .read(begin, end - begin)
                .then((chunk) => this.onDataRange(begin, chunk))
                .catch(() => this.abort());
        }
    }
    const task = pdfjs.getDocument({
        ...pdfAssetOptions(window.location.origin),
        range: new ReaderTransport(reader.size, null),
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
    });
    // A PDF with a user password asks; the worker refuses it anyway, so the drawer gives up.
    task.onPassword = () => void task.destroy();
    let document: Pdfjs.PDFDocumentProxy;
    try {
        document = await task.promise;
    } catch (error) {
        void reader.close();
        throw error;
    }
    async function render(
        page: number,
        rotate: Rotation,
        edge: number,
        canvas: HTMLCanvasElement | OffscreenCanvas,
    ) {
        const proxy = await document.getPage(page + 1);
        const base = proxy.getViewport({ scale: 1, rotation: rotate });
        const scale = edge / Math.max(base.width, base.height);
        const viewport = proxy.getViewport({ scale, rotation: rotate });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        await proxy.render({ canvas: canvas as HTMLCanvasElement, viewport }).promise;
    }
    return {
        draw: (page, rotate, edge, canvas) => render(page, rotate, edge, canvas),
        async thumbnail(page, rotate, edge, maxBytes) {
            if (typeof OffscreenCanvas === 'undefined') return null;
            try {
                const canvas = new OffscreenCanvas(1, 1);
                await render(page, rotate, edge, canvas);
                for (const quality of [0.82, 0.7, 0.58]) {
                    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
                    if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
                }
            } catch {
                // A page pdf.js can't draw saves without a thumbnail.
            }
            return null;
        },
        close() {
            void task.destroy();
            void reader.close();
        },
    };
}
