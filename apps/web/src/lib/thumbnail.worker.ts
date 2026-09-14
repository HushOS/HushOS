/*
 * Renders thumbnails off the main thread: images through createImageBitmap
 * and an OffscreenCanvas, PDFs through pdf.js running inside this worker (it
 * spawns its own parsing worker underneath), and video frames through
 * mediabunny demuxing the container and WebCodecs decoding one frame. The page
 * stays responsive while a folder of photos, PDFs or clips is dropped. Where
 * WebCodecs cannot decode a codec the main thread falls back to a <video>.
 */

import type * as Pdfjs from 'pdfjs-dist';

type Job = {
    id: number;
    kind: 'image' | 'pdf' | 'video';
    file: Blob;
    edge: number;
    maxBytes: number;
};
type Reply = { id: number; blob: Blob | null; error?: string };

async function encode(
    source: CanvasImageSource,
    width: number,
    height: number,
    edge: number,
    maxBytes: number,
) {
    if (!width || !height) return null;
    for (const size of [edge, Math.round(edge * 0.75), Math.round(edge * 0.5)]) {
        const scale = Math.min(1, size / Math.max(width, height));
        const canvas = new OffscreenCanvas(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
        );
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.82, 0.65, 0.45]) {
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
            if (blob.size <= maxBytes) return blob;
        }
    }
    return null;
}

async function fromImage(job: Job) {
    const bitmap = await createImageBitmap(job.file);
    try {
        return await encode(bitmap, bitmap.width, bitmap.height, job.edge, job.maxBytes);
    } finally {
        bitmap.close();
    }
}

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

async function fromPdf(job: Job) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
        data: new Uint8Array(await job.file.arrayBuffer()),
        // Nothing here may reach the network: fonts not embedded fall back to the
        // worker's own, and no external resources are ever requested.
        disableFontFace: false,
    });
    try {
        const document = await task.promise;
        const page = await document.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = (job.edge * 2) / Math.max(base.width, base.height);
        const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        return await encode(canvas, canvas.width, canvas.height, job.edge, job.maxBytes);
    } finally {
        await task.destroy();
    }
}

/*
 * A frame about a second in, or halfway through a short clip, decoded by
 * WebCodecs from the container mediabunny demuxes; nothing is transcoded.
 */
async function fromVideo(job: Job) {
    if (typeof VideoDecoder === 'undefined') return null;
    const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(job.file) });
    try {
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) return null;
        const duration = await track.computeDuration();
        const first = await track.getFirstTimestamp();
        const at = first + Math.min(1, Math.max(0, duration - first) / 2);
        const scale = Math.min(1, job.edge / Math.max(track.displayWidth, track.displayHeight));
        const sink = new CanvasSink(track, {
            width: Math.max(1, Math.round(track.displayWidth * scale)),
            height: Math.max(1, Math.round(track.displayHeight * scale)),
            fit: 'fill',
        });
        const wrapped = (await sink.getCanvas(at)) ?? (await sink.getCanvas(first));
        if (!wrapped) return null;
        const canvas = wrapped.canvas as OffscreenCanvas;
        return await encode(canvas, canvas.width, canvas.height, job.edge, job.maxBytes);
    } finally {
        input.dispose();
    }
}

self.onmessage = async (event: MessageEvent<Job>) => {
    const job = event.data;
    const reply = (message: Reply) => self.postMessage(message);
    try {
        const blob =
            job.kind === 'pdf'
                ? await fromPdf(job)
                : job.kind === 'video'
                  ? await fromVideo(job)
                  : await fromImage(job);
        reply({ id: job.id, blob });
    } catch (error) {
        reply({
            id: job.id,
            blob: null,
            error: error instanceof Error ? error.message : 'The thumbnail could not be rendered.',
        });
    }
};
