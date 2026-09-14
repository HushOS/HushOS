import { versionEnvelopeOf, type DriveNode } from '@hushos/drive/client';
import { THUMBNAIL_BATCH, THUMBNAIL_MAX_BYTES } from '@hushos/drive/protocol';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { driveApi } from '@/lib/drive-api';
import { previewKind } from '@/lib/previews';

/*
 * Thumbnails are made by the uploader and decrypted by the reader; the server
 * never sees a pixel, and never learns which files have one, because the
 * thumbnail is sealed into the file's own object as a trailer and only the
 * version envelope says it is there. Rendering happens here from the File
 * before it is encrypted: a 256-pixel WebP of at most 64 KiB for an image, a
 * PDF's first page or a frame of a video. Reading batches the versions in
 * view into one request for their objects' URLs, fetches and decrypts each
 * trailer in the worker, and keeps the decoded images in memory for the
 * session, never on disk.
 */

const THUMBNAIL_EDGE = 256;
const RENDER_TIMEOUT_MS = 30_000;
const RENDER_CONCURRENCY = 2;

/*
 * Images, PDFs and video frames render in a dedicated worker; a video whose
 * codec WebCodecs cannot decode falls back to a <video> element here. Either
 * way at most two renders run at once, so a folder dropped at once queues
 * rather than stalling the page.
 */
let worker: Worker | null = null;
let nextJob = 1;
const jobs = new Map<number, { resolve: (blob: Blob | null) => void }>();
function renderer() {
    if (worker) return worker;
    worker = new Worker(new URL('./thumbnail.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; blob: Blob | null }>) => {
        jobs.get(event.data.id)?.resolve(event.data.blob);
        jobs.delete(event.data.id);
    };
    worker.onerror = () => {
        for (const job of jobs.values()) job.resolve(null);
        jobs.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}
function renderInWorker(kind: 'image' | 'pdf' | 'video', file: Blob) {
    return new Promise<Blob | null>((resolve) => {
        const id = nextJob++;
        const timer = setTimeout(() => {
            jobs.delete(id);
            resolve(null);
        }, RENDER_TIMEOUT_MS);
        jobs.set(id, {
            resolve: (blob) => {
                clearTimeout(timer);
                resolve(blob);
            },
        });
        renderer().postMessage({
            id,
            kind,
            file,
            edge: THUMBNAIL_EDGE,
            maxBytes: THUMBNAIL_MAX_BYTES,
        });
    });
}

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (running >= RENDER_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
        return await work();
    } finally {
        running--;
        waiting.shift()?.();
    }
}

/* Draws a source scaled to fit the thumbnail edge and encodes it as WebP under the size cap. */
async function encode(source: CanvasImageSource, width: number, height: number) {
    if (!width || !height) return null;
    for (const edge of [THUMBNAIL_EDGE, 192, 128]) {
        const scale = Math.min(1, edge / Math.max(width, height));
        const canvas = new OffscreenCanvas(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
        );
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.82, 0.65, 0.45]) {
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
            if (blob.size <= THUMBNAIL_MAX_BYTES) return blob;
        }
    }
    return null;
}

/* An image the worker refused (an SVG without intrinsic size, say) goes through <img> here. */
async function fromImageElement(file: File) {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.decoding = 'async';
        image.src = url;
        await image.decode();
        return await encode(image, image.naturalWidth || 256, image.naturalHeight || 256);
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function fromVideo(file: File) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error('This video cannot be decoded here.'));
        });
        const at = Math.min(1, (video.duration || 0) / 2);
        await new Promise<void>((resolve, reject) => {
            video.onseeked = () => resolve();
            video.onerror = () => reject(new Error('Seek failed.'));
            video.currentTime = Number.isFinite(at) ? at : 0;
        });
        return await encode(video, video.videoWidth, video.videoHeight);
    } catch {
        return null;
    } finally {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}

/* A thumbnail for a file about to be uploaded, or null when its type has none. */
export async function renderThumbnail(file: File, mime: string | null): Promise<Blob | null> {
    if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') return null;
    const stand = {
        kind: 'file',
        name: file.name,
        metadata: { mime, name: file.name, size: file.size, modified: null },
        currentVersion: { plaintextSize: String(file.size) },
        content: { plaintextSize: file.size, thumbnailBytes: 0 },
    } as unknown as DriveNode;
    switch (previewKind(stand)) {
        case 'image':
            return limited(
                async () => (await renderInWorker('image', file)) ?? fromImageElement(file),
            );
        case 'video':
            return limited(async () => (await renderInWorker('video', file)) ?? fromVideo(file));
        case 'pdf':
            return file.size <= 64 * 1024 * 1024
                ? limited(() => renderInWorker('pdf', file))
                : null;
        default:
            return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

type Entry = { url: string } | { failed: true };
const cache = new Map<string, Entry>();
const pending = new Map<string, DriveNode>();
const listeners = new Set<() => void>();
let flush: ReturnType<typeof setTimeout> | null = null;

function notify() {
    for (const listener of listeners) listener();
}

/* One request per workspace: a shared folder's thumbnails come from its owner's workspace. */
async function fetchBatch(all: DriveNode[]) {
    const byWorkspace = new Map<string, DriveNode[]>();
    for (const node of all)
        byWorkspace.set(node.workspaceId, [...(byWorkspace.get(node.workspaceId) ?? []), node]);
    await Promise.all(
        [...byWorkspace].map(([workspaceId, nodes]) => fetchWorkspaceBatch(workspaceId, nodes)),
    );
}

async function fetchWorkspaceBatch(workspaceId: string, nodes: DriveNode[]) {
    const workspace = { workspaceId };
    const byVersion = new Map(nodes.map((node) => [node.currentVersion!.id, node]));
    try {
        const { urls } = await driveApi.thumbnailUrls(workspace.workspaceId, [...byVersion.keys()]);
        const seen = new Set<string>();
        await Promise.all(
            urls.map(async ({ versionId, url }) => {
                seen.add(versionId);
                const node = byVersion.get(versionId);
                const version = node?.currentVersion;
                if (!node || !version) return;
                try {
                    const { plaintext } = await authClient.rpc('driveThumbnailFetch', {
                        workspaceId: workspace.workspaceId,
                        nodeId: node.id,
                        version: versionEnvelopeOf(version),
                        contentNonce: version.contentNonce,
                        url,
                    });
                    const blob = new Blob([plaintext as BlobPart], { type: 'image/webp' });
                    cache.set(version.id, { url: URL.createObjectURL(blob) });
                } catch {
                    cache.set(version.id, { failed: true });
                }
            }),
        );
        // A version the server would not hand out (not ready, or not ours) stays without one.
        for (const id of byVersion.keys()) if (!seen.has(id)) cache.set(id, { failed: true });
    } catch {
        for (const id of byVersion.keys()) cache.set(id, { failed: true });
    }
    notify();
}

function scheduleFlush() {
    if (flush) return;
    flush = setTimeout(() => {
        flush = null;
        const nodes = [...pending.values()];
        pending.clear();
        for (let i = 0; i < nodes.length; i += THUMBNAIL_BATCH)
            void fetchBatch(nodes.slice(i, i + THUMBNAIL_BATCH));
    }, 30);
}

/* Whether a node has a thumbnail worth asking for: its envelope said there is a trailer. */
export function hasThumbnail(node: DriveNode) {
    return node.kind === 'file' && (node.content?.thumbnailBytes ?? 0) > 0;
}

/* Asks for a node's thumbnail, batched with the others asked for in the same moment. */
export function requestThumbnail(node: DriveNode) {
    const version = node.currentVersion;
    if (!version || !hasThumbnail(node) || cache.has(version.id) || pending.has(version.id)) return;
    pending.set(version.id, node);
    scheduleFlush();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/* The decoded thumbnail's blob URL, once it has arrived; null before, or when there is none. */
export function useThumbnail(node: DriveNode | null) {
    const versionId = node?.currentVersion?.id ?? null;
    const snapshot = () => {
        if (!versionId) return null;
        const entry = cache.get(versionId);
        return entry && 'url' in entry ? entry.url : null;
    };
    const url = useSyncExternalStore(subscribe, snapshot, () => null);
    if (node && url === null && hasThumbnail(node)) requestThumbnail(node);
    return url;
}

/* After a lock, the keys and every decoded image go. */
export function forgetThumbnails() {
    for (const entry of cache.values()) if ('url' in entry) URL.revokeObjectURL(entry.url);
    cache.clear();
    pending.clear();
    notify();
}
