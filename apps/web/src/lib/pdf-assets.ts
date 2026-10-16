const { base, preload } = __PDFJS_ASSETS__;

/*
 * Where pdf.js fetches its wasm decoders, standard fonts, ICC profiles and
 * CMaps, all on this origin (see `pdfjsAssets` in vite.config.ts). Absolute,
 * because pdf.js fetches them from its own worker. Inside a worker of ours
 * pdf.js cannot read `document.baseURI` to decide that itself, so the worker
 * asks for `useWorkerFetch` too.
 */
export function pdfAssetOptions(origin: string) {
    const root = new URL(base, origin).href;
    return {
        wasmUrl: `${root}wasm/`,
        standardFontDataUrl: `${root}standard_fonts/`,
        cMapUrl: `${root}cmaps/`,
        cMapPacked: true,
        iccUrl: `${root}iccs/`,
    };
}

const CONCURRENCY = 6;
let ready: Promise<void> | null = null;

/*
 * Every one of them, fetched into the HTTP cache before pdf.js reads anything.
 * pdf.js asks only for what a document needs, so which ones a device fetched
 * would tell the server that a PDF holds a scanned image or Korean text. The
 * viewer and the thumbnailer wait on this, so a link visitor or a PDF opened
 * before the idle preload has run fetches the full set too. Once cached they
 * are not asked for again: the path is versioned and served immutable. A file
 * that fails is skipped, so one blocked request does not leave the rest to be
 * fetched on demand.
 */
export function pdfAssetsReady() {
    ready ??= (async () => {
        const queue = [...preload];
        const next = async (): Promise<void> => {
            const file = queue.shift();
            if (!file) return;
            await fetch(new URL(base + file, window.location.origin), { cache: 'force-cache' })
                .then((response) => response.arrayBuffer())
                .catch(() => {});
            return next();
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, next));
    })();
    return ready;
}
