import type { DriveNode } from '@hushos/drive/client';
import { expect, test, vi } from 'vitest';

/*
 * A thumbnail range that fails to arrive fails the drawer, its loading task destroyed and its reader
 * closed: pdf.js would otherwise wait for that range for ever (its transport's abort does nothing),
 * and a save waiting on a thumbnail with it.
 */

vi.mock('@/lib/drive/transfers/downloads', () => ({ downloads: {} }));
vi.mock('@/lib/viewers/pdf-assets', () => ({
    pdfAssetOptions: () => ({}),
    pdfAssetsReady: async () => {},
}));

/* pdf.js as far as a drawer uses it: a document that loads only once its first range has come. */
function stubPdfjs() {
    const destroyed = vi.fn(async () => {});
    class PDFDataRangeTransport {
        arrived = false;
        constructor(
            readonly length: number,
            readonly initial: unknown,
        ) {}
        onDataRange() {
            this.arrived = true;
        }
        abort() {}
        requestDataRange(_begin: number, _end: number) {}
    }
    const getDocument = ({ range }: { range: PDFDataRangeTransport }) => {
        // pdf.js asks for the file's start, and waits.
        queueMicrotask(() => range.requestDataRange(0, 1024));
        return { promise: new Promise(() => {}), destroy: destroyed, onPassword: null };
    };
    return { pdfjs: { PDFDataRangeTransport, getDocument }, destroyed };
}

test('a range that fails rejects the drawer, destroys its task and closes its reader', async () => {
    const { openPageDrawer } = await import('./page-thumbnails');
    const { pdfjs, destroyed } = stubPdfjs();
    const close = vi.fn();
    const opening = openPageDrawer({} as DriveNode, {
        load: async () => pdfjs as never,
        ready: async () => {},
        open: () => ({
            size: 4096,
            read: () => Promise.reject(new Error('The range could not be read.')),
            close,
        }),
    });
    await expect(opening).rejects.toThrow('The range could not be read.');
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
});
