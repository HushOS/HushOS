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

/*
 * Every one of them, fetched into the HTTP cache ahead of the first PDF.
 * pdf.js asks only for what a document needs, so which ones a device fetched
 * would tell the server that a PDF holds a scanned image or Japanese text.
 * Once cached they are never asked for again: the path is versioned and
 * served immutable.
 */
export async function preloadPdfAssets(origin: string) {
    for (const file of preload)
        await fetch(new URL(base + file, origin), { cache: 'force-cache' }).then((response) =>
            response.arrayBuffer(),
        );
}
