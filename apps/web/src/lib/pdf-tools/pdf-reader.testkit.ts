import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/*
 * Test help for the PDF tools suites and the end-to-end spec: a PDF as pdf.js shows it, each page's
 * MediaBox size, its rotation, and the "Page n" its content draws (the fixtures in
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
            const text = await page.getTextContent();
            const label = text.items
                .map((item) => ('str' in item ? item.str : ''))
                .find((value) => /^Page \d+$/.test(value));
            pages.push({ width: x2 - x1, height: y2 - y1, rotate: page.rotate, label });
        }
    } finally {
        await task.destroy();
    }
    return pages;
}
