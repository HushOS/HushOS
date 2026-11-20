import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/*
 * Test help for the PDF tools suites and the end-to-end spec: a PDF as pdf.js shows it, each page's
 * MediaBox size (in points, /UserUnit applied), its rotation, and the "Page n" its content draws (the fixtures in
 * e2e/fixtures/pdfs draw one on every page), so order is read from what a reader shows.
 */
export async function pdfPages(bytes: Uint8Array) {
    const task = pdfjs.getDocument({ data: bytes.slice(), isOffscreenCanvasSupported: false });
    const doc = await task.promise;
    const pages: { width: number; height: number; rotate: number; label: string | undefined }[] =
        [];
    try {
        for (let number = 1; number <= doc.numPages; number++) {
            const page = await doc.getPage(number);
            const [x1, y1, x2, y2] = page.view as [number, number, number, number];
            // The boxes are in the page's own units: /UserUnit points each.
            const unit = page.userUnit || 1;
            const text = await page.getTextContent();
            const label = text.items
                .map((item) => ('str' in item ? item.str : ''))
                .find((value) => /^Page \d+$/.test(value));
            pages.push({
                width: (x2 - x1) * unit,
                height: (y2 - y1) * unit,
                rotate: page.rotate,
                label,
            });
        }
    } finally {
        await task.destroy();
    }
    return pages;
}

/* The optional content groups pdf.js sees, and how many it would hide. */
export async function pdfLayers(bytes: Uint8Array) {
    const task = pdfjs.getDocument({ data: bytes.slice(), isOffscreenCanvasSupported: false });
    const doc = await task.promise;
    try {
        const config = await doc.getOptionalContentConfig();
        const groups = [...config].map(([, group]) => group);
        return {
            layers: groups.length,
            hiddenLayers: groups.filter((group) => !group.visible).length,
        };
    } finally {
        await task.destroy();
    }
}
