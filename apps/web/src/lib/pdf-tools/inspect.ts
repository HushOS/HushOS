import { ToolError } from '@/lib/tools/worker';
import { PDF_TOOLS_MAX_PAGES, pagesText, type InspectedSource } from './protocol';
import { PdfRefused, type SourcePdf } from './structure';

/*
 * Inspect's walk over the PDFs, in order (pdf-tools.tool-worker.ts): each opened with what is left of
 * the run's 2,000 pages, so the walk stops at the page that passes them, never after reading the rest.
 * A PDF that passes them alone is refused as itself; one that passes them only with those before it
 * stops the look with `too-many-pages-together`, which the page puts into words. Kept apart from the
 * worker, so it is tested without one.
 */
export async function inspectAll(
    count: number,
    open: (index: number, maxPages: number) => Promise<SourcePdf>,
    { maxPages = PDF_TOOLS_MAX_PAGES, onDone = () => {} } = {},
) {
    const inspected: InspectedSource[] = [];
    let left = maxPages;
    for (let index = 0; index < count; index++) {
        try {
            const pdf = await open(index, left);
            left -= pdf.pages.length;
            inspected.push({
                ok: true,
                pages: pagesText(pdf.pages.map((page) => page.info)),
                ...pdf.flags,
            });
        } catch (error) {
            if (!(error instanceof PdfRefused) || error.reason === 'too-large') throw error;
            if (error.reason === 'too-many-pages' && left < maxPages)
                throw new ToolError('too-many-pages-together');
            inspected.push({ ok: false, reason: error.reason });
        }
        onDone();
    }
    return inspected;
}
