import type { DriveNode } from '@hushos/drive/client';
import { officeKind } from '@/lib/office';
import type { FileReader } from '@hushos/drive/downloads';
import { downloadWorker } from '@/lib/download-sinks';
import { downloads } from '@/lib/downloads';
import { languageFor } from '@/lib/highlight';

/*
 * Previews are the client decrypting bytes it fetched by range and rendering
 * them itself. Every viewer reads through one `FileReader` from the download
 * engine: images and text read everything, PDF asks for the ranges pdf.js wants,
 * and media is served to a player page by the download service worker, which
 * asks this page for each range as the element seeks. Decrypted bytes live in
 * memory and blob URLs only, never in storage or the cache.
 */

export type PreviewKind =
    | 'image'
    | 'pdf'
    | 'text'
    | 'markdown'
    | 'video'
    | 'audio'
    | 'office'
    | 'none';

export const PREVIEW_LIMITS = {
    image: 100 * 1024 * 1024,
    text: 8 * 1024 * 1024,
    /* A PDF up to this size is read whole and remembered; larger ones stream by range. */
    document: 16 * 1024 * 1024,
    /* A clip up to this size plays from memory and is remembered; larger media streams by range. */
    media: 16 * 1024 * 1024,
    /* Media falls back to a blob where the service worker is unavailable. */
    mediaBlob: 256 * 1024 * 1024,
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
const TEXT_EXT = new Set([
    'txt',
    'md',
    'markdown',
    'json',
    'csv',
    'tsv',
    'log',
    'xml',
    'yaml',
    'yml',
    'toml',
    'ini',
    'env',
    'sh',
    'bash',
    'zsh',
    'js',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'jsx',
    'css',
    'scss',
    'html',
    'htm',
    'py',
    'rb',
    'rs',
    'go',
    'java',
    'kt',
    'swift',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'php',
    'sql',
    'graphql',
    'lock',
    'gitignore',
]);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba']);

export function extensionOf(name: string) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* What a file can be shown as, from its recorded type and, failing that, its name. */
export function previewKind(node: DriveNode): PreviewKind {
    if (node.kind !== 'file' || !node.currentVersion) return 'none';
    const mime = (node.metadata?.mime ?? '').toLowerCase();
    const ext = extensionOf(node.name);
    if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
    if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
    if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown' || ext === 'mdx')
        return 'markdown';
    if (officeKind(node.name, mime)) return 'office';
    if (
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime === 'application/xml' ||
        mime === 'application/javascript' ||
        mime === 'application/x-sh' ||
        mime === 'application/toml' ||
        mime === 'application/yaml' ||
        TEXT_EXT.has(ext) ||
        languageFor(node.name) !== null
    )
        return 'text';
    return 'none';
}

const TEXT_SNIFF_BYTES = 8 * 1024;

/*
 * Whether bytes look like text: valid UTF-8 with no NUL and few control
 * characters. Lets a file with an unknown extension still open as text.
 */
export function looksLikeText(bytes: Uint8Array) {
    if (!bytes.length) return true;
    const sample = bytes.subarray(0, TEXT_SNIFF_BYTES);
    let control = 0;
    for (const byte of sample) {
        if (byte === 0) return false;
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) control++;
    }
    if (control / sample.length > 0.02) return false;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(
            // A cut in the middle of a multibyte sequence is not corruption.
            bytes.length > TEXT_SNIFF_BYTES ? sample.subarray(0, sample.length - 4) : sample,
        );
        return true;
    } catch {
        return false;
    }
}

/* The type a viewer should present the bytes as; a name-only guess for the common cases. */
export function previewMime(node: DriveNode) {
    const recorded = node.metadata?.mime;
    if (recorded) return recorded;
    const ext = extensionOf(node.name);
    const table: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        mp4: 'video/mp4',
        m4v: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        flac: 'audio/flac',
        opus: 'audio/ogg',
    };
    return table[ext] ?? 'application/octet-stream';
}

export function openReader(node: DriveNode) {
    return downloads.openReader(node);
}

/* Everything, in chunk-sized reads, up to `limit` bytes. */
export async function readAll(reader: FileReader, limit: number) {
    const size = Math.min(reader.size, limit);
    const out = new Uint8Array(size);
    const step = 8 * 1024 * 1024;
    for (let offset = 0; offset < size; offset += step)
        out.set(await reader.read(offset, Math.min(step, size - offset)), offset);
    return { bytes: out, truncated: reader.size > limit };
}

export type ServedMedia = { url: string; release: () => void };

/*
 * Serves a file to the download worker's player page. The worker asks this page
 * for ranges as the media element plays and seeks; nothing is buffered beyond
 * the window in flight. Null where the worker is unavailable.
 */
export async function serveMedia(
    reader: FileReader,
    file: { name: string; mime: string; kind: 'video' | 'audio' },
): Promise<ServedMedia | null> {
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
        worker.postMessage(
            {
                type: 'serve',
                id,
                size: reader.size,
                mime: file.mime,
                name: file.name,
                kind: file.kind,
            },
            [channel.port2],
        );
    });
    if (!url) return null;
    channel.port1.onmessage = (event) => {
        const msg = event.data as { type: string; requestId: number; start: number; end: number };
        if (msg?.type !== 'range') return;
        reader
            .read(msg.start, msg.end - msg.start + 1)
            .then((chunk) => {
                const copy = chunk.slice();
                channel.port1.postMessage(
                    { type: 'data', requestId: msg.requestId, chunk: copy.buffer },
                    [copy.buffer],
                );
            })
            .catch((error: unknown) =>
                channel.port1.postMessage({
                    type: 'fail',
                    requestId: msg.requestId,
                    message: error instanceof Error ? error.message : 'The read failed.',
                }),
            );
    };
    return {
        url,
        release: () => {
            channel.port1.postMessage({ type: 'release' });
            channel.port1.close();
        },
    };
}

/* ------------------------------------------------------------------------- */
/* Remembering                                                                */
/* ------------------------------------------------------------------------- */

/*
 * Decoded previews kept for the session, so opening a file again is instant:
 * text as a string, images and short clips as a blob URL, documents (PDF and
 * Office) as their decrypted bytes. Memory only, bounded, and dropped on lock
 * together with every other decrypted thing. Media past the limit streams by
 * range and is not kept.
 */
export type RememberedPreview =
    | { kind: 'text'; text: string; truncated: boolean; bytes: number }
    | { kind: 'image'; url: string; bytes: number }
    | { kind: 'document'; data: Uint8Array; bytes: number }
    | { kind: 'media'; url: string; bytes: number };

const PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const remembered = new Map<string, RememberedPreview>();
let rememberedBytes = 0;

export function recallPreview(versionId: string) {
    const entry = remembered.get(versionId);
    if (!entry) return null;
    // Most recently used moves to the end.
    remembered.delete(versionId);
    remembered.set(versionId, entry);
    return entry;
}

export function rememberPreview(versionId: string, entry: RememberedPreview) {
    if (entry.bytes > PREVIEW_CACHE_BYTES / 4) return;
    const previous = remembered.get(versionId);
    if (previous) evict(versionId, previous);
    remembered.set(versionId, entry);
    rememberedBytes += entry.bytes;
    for (const [id, old] of remembered) {
        if (rememberedBytes <= PREVIEW_CACHE_BYTES) break;
        if (id !== versionId) evict(id, old);
    }
}

function evict(versionId: string, entry: RememberedPreview) {
    remembered.delete(versionId);
    rememberedBytes -= entry.bytes;
    if (entry.kind === 'image' || entry.kind === 'media') URL.revokeObjectURL(entry.url);
}

export function forgetPreviews() {
    for (const [id, entry] of remembered) evict(id, entry);
}
