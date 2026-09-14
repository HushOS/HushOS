/*
 * HushOS download service worker. Two jobs, both about turning plaintext the page
 * decrypts into something the browser can treat as an ordinary resource,
 * without the file ever sitting in memory or on disk unencrypted:
 *
 *  - Downloads. The page posts chunks over a MessageChannel and this worker
 *    answers a fetch for a one-off URL with a streaming Response, so the
 *    browser's own download UI shows the file arriving.
 *  - Media previews. The page registers a source it can read by range, and this
 *    worker serves a small player page plus the media itself with Range support,
 *    so <video> and <audio> seek the way they would on any server.
 *
 * Scope is /hushos-download/ only; nothing else the app does passes through
 * here. Plain JavaScript on purpose: served as a static file at its own URL so
 * the browser can register it, and small enough to read in one sitting.
 */

const downloads = new Map();
const sources = new Map();
const MEDIA_WINDOW = 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !event.ports[0]) return;
    if (data.type === 'start') startDownload(data, event.ports[0]);
    else if (data.type === 'serve') startSource(data, event.ports[0]);
});

function startDownload(data, port) {
    const id = data.id;
    const headers = new Headers({
        'Content-Type': 'application/octet-stream; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(data.filename)}`,
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    if (typeof data.size === 'number' && data.size >= 0)
        headers.set('Content-Length', String(data.size));
    let controller = null;
    const queue = [];
    let ended = false;
    const stream = new ReadableStream({
        start(c) {
            controller = c;
            for (const chunk of queue) c.enqueue(chunk);
            queue.length = 0;
            if (ended) c.close();
        },
        cancel() {
            port.postMessage({ type: 'cancelled' });
            downloads.delete(id);
        },
    });
    port.onmessage = (message) => {
        const msg = message.data;
        if (!msg) return;
        if (msg.type === 'chunk') {
            const chunk = new Uint8Array(msg.chunk);
            if (controller) controller.enqueue(chunk);
            else queue.push(chunk);
            // One chunk at a time: the page waits for this before sending the next.
            port.postMessage({ type: 'ack' });
        } else if (msg.type === 'end') {
            ended = true;
            if (controller) controller.close();
        } else if (msg.type === 'abort') {
            if (controller) controller.error(new Error('Download aborted.'));
            downloads.delete(id);
        }
    };
    downloads.set(id, { stream, headers });
    const url = new URL(
        `/hushos-download/${encodeURIComponent(id)}/${encodeURIComponent(data.filename)}`,
        self.registration.scope,
    ).href;
    port.postMessage({ type: 'ready', url });
}

/* A media source the page reads by range on this worker's behalf. */
function startSource(data, port) {
    const source = {
        id: data.id,
        size: data.size,
        mime: data.mime,
        name: data.name,
        kind: data.kind,
        port,
        pending: new Map(),
        nextRequest: 1,
    };
    port.onmessage = (message) => {
        const msg = message.data;
        if (!msg) return;
        if (msg.type === 'data' || msg.type === 'fail') {
            const waiting = source.pending.get(msg.requestId);
            if (!waiting) return;
            source.pending.delete(msg.requestId);
            if (msg.type === 'data') waiting.resolve(new Uint8Array(msg.chunk));
            else waiting.reject(new Error(msg.message || 'The read failed.'));
        } else if (msg.type === 'release') {
            for (const waiting of source.pending.values())
                waiting.reject(new Error('The preview was closed.'));
            source.pending.clear();
            sources.delete(source.id);
        }
    };
    sources.set(source.id, source);
    const url = new URL(
        `/hushos-download/player/${encodeURIComponent(source.id)}`,
        self.registration.scope,
    ).href;
    port.postMessage({ type: 'ready', url });
}

function readRange(source, start, end) {
    return new Promise((resolve, reject) => {
        const requestId = source.nextRequest++;
        source.pending.set(requestId, { resolve, reject });
        source.port.postMessage({ type: 'range', requestId, start, end });
    });
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function playerPage(source) {
    const title = escapeHtml(source.name);
    const src = `/hushos-download/media/${encodeURIComponent(source.id)}`;
    const element =
        source.kind === 'audio'
            ? `<audio controls autoplay preload="metadata" src="${src}"></audio>`
            : `<video controls autoplay playsinline preload="metadata" src="${src}"></video>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${title}</title><style>html,body{margin:0;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100%;width:100%;height:100%;outline:none;background:#000}audio{width:min(100%,40rem)}</style></head><body>${element}</body></html>`;
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
                "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
        },
    });
}

/* The media itself, whole or by range, pulled from the page a window at a time. */
function mediaResponse(source, request) {
    const size = source.size;
    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = request.headers.get('Range');
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        const unsatisfiable = () =>
            new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        if (!match || (match[1] === '' && match[2] === '')) return unsatisfiable();
        if (match[1] === '') start = Math.max(0, size - Number(match[2]));
        else {
            start = Number(match[1]);
            if (match[2] !== '') end = Math.min(end, Number(match[2]));
        }
        if (start > end || start >= size) return unsatisfiable();
        partial = true;
    }
    let cursor = start;
    const body = new ReadableStream({
        async pull(controller) {
            if (cursor > end) {
                controller.close();
                return;
            }
            const stop = Math.min(end, cursor + MEDIA_WINDOW - 1);
            try {
                const chunk = await readRange(source, cursor, stop);
                cursor += chunk.byteLength;
                if (chunk.byteLength === 0) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
            } catch (error) {
                controller.error(error);
            }
        },
    });
    const headers = new Headers({
        'Content-Type': source.mime || 'application/octet-stream',
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    return new Response(body, { status: partial ? 206 : 200, headers });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const player = url.pathname.match(/^\/hushos-download\/player\/([^/]+)$/);
    if (player) {
        const source = sources.get(decodeURIComponent(player[1]));
        event.respondWith(
            source
                ? playerPage(source)
                : new Response('This preview has ended. Open the file again.', { status: 410 }),
        );
        return;
    }
    const media = url.pathname.match(/^\/hushos-download\/media\/([^/]+)$/);
    if (media) {
        const source = sources.get(decodeURIComponent(media[1]));
        event.respondWith(
            source ? mediaResponse(source, event.request) : new Response(null, { status: 410 }),
        );
        return;
    }
    const match = url.pathname.match(/^\/hushos-download\/([^/]+)\//);
    if (!match) return;
    const id = decodeURIComponent(match[1]);
    const entry = downloads.get(id);
    if (!entry) {
        event.respondWith(
            new Response('This download has expired. Start it again.', { status: 410 }),
        );
        return;
    }
    downloads.delete(id);
    event.respondWith(new Response(entry.stream, { headers: entry.headers }));
});
