/*
 * Every viewer, syntax grammar and thumbnailer the app loads on first use,
 * fetched once after unlock when the browser is idle. Otherwise which chunks
 * a device fetched (pdf.js, SheetJS, the Rust grammar, the video demuxer)
 * would tell whoever serves the app what kind of file was just opened or
 * uploaded, though the file itself is end-to-end encrypted. Only inside the
 * app, after unlock: a public page or a link visitor never pays for it.
 */
let started = false;

function whenIdle(work: () => void) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(work, { timeout: 15_000 });
    else setTimeout(work, 3_000);
}

export function preloadViewers() {
    if (started || typeof window === 'undefined') return;
    started = true;
    whenIdle(() => {
        // One after another, so the fetches never crowd out what the person is doing.
        void (async () => {
            const steps: (() => Promise<unknown>)[] = [
                () => import('@/components/drive/pdf-viewer').then((m) => m.preloadPdf()),
                () => import('@/components/drive/office-viewer').then((m) => m.preloadOffice()),
                () => import('@/components/drive/rich-text'),
                () => import('@/lib/highlight').then((m) => m.preloadGrammars()),
                () => import('@/lib/thumbnails').then((m) => m.preloadThumbnailer()),
            ];
            for (const step of steps) await step().catch(() => {});
            document.documentElement.dataset.viewersPreloaded = 'true';
        })();
    });
}
