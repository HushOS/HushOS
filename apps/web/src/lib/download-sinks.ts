import type { DownloadSink } from '@hushos/drive/downloads';

/*
 * Where a decrypted download goes. The service worker is the default: the
 * browser shows its ordinary download with progress and the file never sits in
 * memory. Where that is unavailable, the File System Access API writes straight
 * to a file the person picked, and as a last resort a blob is assembled in
 * memory, which is why that path refuses very large files.
 */

const BLOB_LIMIT = 256 * 1024 * 1024;
const SW_SCRIPT = '/download-sw.js';
const SW_SCOPE = '/hushos-download/';

let registration: Promise<ServiceWorkerRegistration | null> | undefined;
let workerAvailable: boolean | null = null;

/* Whether the service worker path is known to be unavailable here, once probed. */
export function serviceWorkerUnavailable() {
    return workerAvailable === false;
}

/* Registers the download worker once; resolves null where service workers are off. */
export function downloadWorker() {
    registration ??= (async () => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
            workerAvailable = false;
            return null;
        }
        try {
            const reg = await navigator.serviceWorker.register(SW_SCRIPT, { scope: SW_SCOPE });
            // Not `navigator.serviceWorker.ready`: that waits for a worker whose scope
            // covers this page, and this one deliberately covers only its own path.
            const worker = reg.active ?? reg.waiting ?? reg.installing;
            if (!worker) return null;
            if (worker.state !== 'activated')
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, 10_000);
                    function done() {
                        clearTimeout(timer);
                        worker!.removeEventListener('statechange', onChange);
                        resolve();
                    }
                    function onChange() {
                        if (worker!.state === 'activated' || worker!.state === 'redundant') done();
                    }
                    worker.addEventListener('statechange', onChange);
                });
            workerAvailable = worker.state === 'activated';
            return workerAvailable ? reg : null;
        } catch {
            workerAvailable = false;
            return null;
        }
    })();
    return registration;
}

async function serviceWorkerSink(file: { name: string; size: number | null }) {
    const reg = await downloadWorker();
    const worker = reg?.active;
    if (!worker) return null;
    const channel = new MessageChannel();
    const id = crypto.randomUUID();
    const url = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 3_000);
        channel.port1.onmessage = (event) => {
            if (event.data?.type === 'ready') {
                clearTimeout(timer);
                resolve(event.data.url as string);
            }
        };
        worker.postMessage({ type: 'start', id, filename: file.name, size: file.size }, [
            channel.port2,
        ]);
    });
    if (!url) return null;
    let acknowledged: (() => void) | null = null;
    let cancelled = false;
    channel.port1.onmessage = (event) => {
        if (event.data?.type === 'ack') acknowledged?.();
        if (event.data?.type === 'cancelled') {
            cancelled = true;
            acknowledged?.();
        }
    };
    // The browser starts the download when this frame navigates to the URL.
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = url;
    document.body.append(frame);
    const cleanup = () => setTimeout(() => frame.remove(), 60_000);
    const sink: DownloadSink = {
        async write(chunk) {
            if (cancelled) throw new Error('The download was cancelled in the browser.');
            const copy = chunk.slice();
            await new Promise<void>((resolve) => {
                acknowledged = resolve;
                channel.port1.postMessage({ type: 'chunk', chunk: copy.buffer }, [copy.buffer]);
            });
            acknowledged = null;
            if (cancelled) throw new Error('The download was cancelled in the browser.');
        },
        async close() {
            channel.port1.postMessage({ type: 'end' });
            cleanup();
        },
        async abort() {
            channel.port1.postMessage({ type: 'abort' });
            cleanup();
        },
    };
    return sink;
}

type SaveFilePicker = (options: {
    suggestedName?: string;
}) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;

async function fileSystemSink(file: { name: string }) {
    const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (!picker) return null;
    let handle;
    try {
        handle = await picker({ suggestedName: file.name });
    } catch {
        // The person cancelled the dialog, or the call lost its user activation.
        return null;
    }
    const writable = await handle.createWritable();
    const sink: DownloadSink = {
        write: (chunk) => writable.write(chunk.slice()),
        close: () => writable.close(),
        abort: (reason) => writable.abort(reason),
    };
    return sink;
}

function blobSink(file: { name: string; size: number | null }): DownloadSink {
    if (file.size !== null && file.size > BLOB_LIMIT)
        throw new Error(
            'This browser cannot stream downloads to disk, and the file is too large to hold in memory.',
        );
    const parts: Uint8Array[] = [];
    let total = 0;
    return {
        async write(chunk) {
            total += chunk.byteLength;
            if (total > BLOB_LIMIT)
                throw new Error('This download grew too large to hold in memory in this browser.');
            parts.push(chunk.slice());
        },
        async close() {
            const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = file.name;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
        async abort() {
            parts.length = 0;
        },
    };
}

/* The sink for a download, best available first. */
export async function openSink(file: { name: string; size: number | null }): Promise<DownloadSink> {
    return (await serviceWorkerSink(file)) ?? (await fileSystemSink(file)) ?? blobSink(file);
}
