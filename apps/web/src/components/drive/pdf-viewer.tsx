import type { FileReader } from '@hushos/drive/downloads';
import type * as Pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PREVIEW_LIMITS, readAll, rememberPreview } from '@/lib/previews';
import '@/components/drive/pdf-viewer.css';

/*
 * PDF through pdf.js in its own worker. A file up to PREVIEW_LIMITS.document is
 * read whole, remembered for the session and handed to pdf.js as bytes, so
 * opening it again costs nothing. A larger one is fed by range: pdf.js asks for
 * the byte ranges it needs and the reader decrypts the chunks that cover them,
 * so the first page shows before the file has finished downloading. Pages
 * render to a canvas as they scroll into view, with a text layer over each.
 */

let pdfjsModule: Promise<typeof Pdfjs> | null = null;
export function loadPdfjs() {
    pdfjsModule ??= Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
    });
    return pdfjsModule;
}

const MAX_RENDER_SCALE = 2;

export function PdfViewer({
    source,
    versionId,
}: {
    /* The file to read, or its bytes when a previous open remembered them. */
    source: FileReader | Uint8Array;
    versionId: string | null;
}) {
    const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [firstPage, setFirstPage] = useState<{ width: number; height: number } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        let active = true;
        let loading: PDFDocumentLoadingTask | null = null;
        void (async () => {
            try {
                const pdfjs = await loadPdfjs();
                let data = source instanceof Uint8Array ? source : null;
                if (
                    !data &&
                    !(source instanceof Uint8Array) &&
                    source.size <= PREVIEW_LIMITS.document
                ) {
                    const { bytes } = await readAll(source, PREVIEW_LIMITS.document);
                    if (!active) return;
                    data = bytes;
                    if (versionId)
                        rememberPreview(versionId, {
                            kind: 'document',
                            data: bytes,
                            bytes: bytes.byteLength,
                        });
                }
                class ReaderTransport extends pdfjs.PDFDataRangeTransport {
                    requestDataRange(begin: number, end: number) {
                        if (source instanceof Uint8Array) return;
                        source
                            .read(begin, end - begin)
                            .then((chunk) => this.onDataRange(begin, chunk))
                            .catch(() => this.abort());
                    }
                }
                // pdf.js moves the buffer to its worker, so the remembered copy stays here.
                const task = data
                    ? pdfjs.getDocument({ data: data.slice() })
                    : pdfjs.getDocument({
                          range: new ReaderTransport((source as FileReader).size, null),
                          rangeChunkSize: 256 * 1024,
                          disableAutoFetch: true,
                          disableStream: true,
                      });
                loading = task;
                const loaded = await task.promise;
                if (!active) return;
                const page = await loaded.getPage(1);
                const viewport = page.getViewport({ scale: 1 });
                if (!active) return;
                setFirstPage({ width: viewport.width, height: viewport.height });
                setDocument(loaded);
            } catch (cause) {
                if (active)
                    setError(
                        cause instanceof Error && cause.name === 'PasswordException'
                            ? 'This PDF is password protected.'
                            : 'This PDF could not be read.',
                    );
            }
        })();
        return () => {
            active = false;
            void loading?.destroy();
        };
    }, [source, versionId]);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setWidth(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    if (error)
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <Alert variant="destructive" className="max-w-md">
                    <AlertTitle>No preview</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            </div>
        );
    // Pages sit on a narrow column at reading width; the scale follows the column.
    const pageWidth = Math.min(Math.max(width - 48, 0), 960);
    const scale = firstPage && pageWidth ? pageWidth / firstPage.width : 1;
    return (
        <div ref={containerRef} className="flex-1 overflow-auto bg-background">
            {!document || !firstPage ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Spinner />
                </div>
            ) : (
                <div className="mx-auto flex flex-col items-center gap-4 px-6 py-6">
                    {Array.from({ length: document.numPages }, (_, index) => (
                        <PdfPage
                            key={index + 1}
                            document={document}
                            number={index + 1}
                            scale={scale}
                            placeholder={{
                                width: firstPage.width * scale,
                                height: firstPage.height * scale,
                            }}
                        />
                    ))}
                    <p className="py-2 text-xs text-muted-foreground tabular-nums">
                        {document.numPages} {document.numPages === 1 ? 'page' : 'pages'}
                    </p>
                </div>
            )}
        </div>
    );
}

function PdfPage({
    document,
    number,
    scale,
    placeholder,
}: {
    document: PDFDocumentProxy;
    number: number;
    scale: number;
    placeholder: { width: number; height: number };
}) {
    const ref = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textRef = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry?.isIntersecting) setVisible(true);
            },
            { rootMargin: '600px 0px' },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        let active = true;
        let page: PDFPageProxy | null = null;
        let renderTask: { cancel(): void } | null = null;
        let textTask: { cancel(): void } | null = null;
        void (async () => {
            const pdfjs = await loadPdfjs();
            page = await document.getPage(number);
            if (!active) return;
            const viewport = page.getViewport({ scale });
            setSize({ width: viewport.width, height: viewport.height });
            const canvas = canvasRef.current;
            const textLayer = textRef.current;
            if (!canvas || !textLayer) return;
            const ratio = Math.min(window.devicePixelRatio || 1, MAX_RENDER_SCALE);
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            const render = page.render({
                canvas,
                viewport: page.getViewport({ scale: scale * ratio }),
            });
            renderTask = render;
            textLayer.replaceChildren();
            textLayer.style.setProperty('--scale-factor', String(scale));
            textLayer.style.setProperty('--total-scale-factor', String(scale));
            const text = new pdfjs.TextLayer({
                textContentSource: page.streamTextContent(),
                container: textLayer,
                viewport,
            });
            textTask = text;
            await Promise.all([render.promise, text.render()]).catch(() => {});
        })();
        return () => {
            active = false;
            renderTask?.cancel();
            textTask?.cancel();
            page?.cleanup();
        };
    }, [visible, document, number, scale]);

    const box = size ?? placeholder;
    return (
        <div
            ref={ref}
            className="relative bg-white shadow-sheet"
            style={{ width: box.width, height: box.height }}
            aria-label={`Page ${number}`}
        >
            <canvas ref={canvasRef} className="block h-full w-full" />
            <div ref={textRef} className="textLayer" />
        </div>
    );
}
