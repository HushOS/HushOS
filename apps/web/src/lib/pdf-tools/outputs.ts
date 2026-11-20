import type { DriveNode } from '@hushos/drive/client';
import { IMAGES_MAX_PIXELS, imageSize, type PageInfo, type PagePlan } from './protocol';

/*
 * The page's checks on what Edit pages' workers hand back, and the plans made before a save starts
 * (make.ts). Pure, so they are tested without a worker or a save run.
 */

/* A worker handed back something it wasn't asked for, or not everything it was. */
export class OutputMismatch extends Error {
    constructor() {
        super('A tool handed back something it wasn’t asked for.');
        this.name = 'OutputMismatch';
    }
}

/*
 * The outputs a run was asked for, by name and type, each taken once and in order: anything else, a
 * second of one, or one missing at the end is a mismatch, so a save never retires with part of its
 * results quietly dropped.
 */
export class OutputLedger {
    #next = 0;
    constructor(
        private readonly names: readonly string[],
        private readonly mime: string,
    ) {}

    /* The planned output this one is, by its place; throws on anything else. */
    take(name: string, mime: string | null) {
        const index = this.#next;
        if (index >= this.names.length || name !== this.names[index] || mime !== this.mime)
            throw new OutputMismatch();
        this.#next++;
        return index;
    }

    /* Every planned output arrived. */
    complete() {
        if (this.#next !== this.names.length) throw new OutputMismatch();
    }
}

/* The PDFs a set of pages came from, as the save path signs them: the weakest of exactly those. */
export function sourcesFor(nodes: readonly DriveNode[], pages: readonly PagePlan[]) {
    const used = [...new Set(pages.map((page) => page.source))].sort((a, b) => a - b);
    return used.map((index) => ({ node: nodes[index]!, source: 'drive' as const }));
}

/* Saving `count` pages as images: a page past IMAGES_MAX_PIXELS refused by its number before anything is made. */
export class PageTooLarge extends Error {
    constructor(readonly page: number) {
        super(
            `Page ${page} is too large to save as an image at this resolution. Choose 150 dpi, or fewer pages.`,
        );
        this.name = 'PageTooLarge';
    }
}

/* Each image's size, or the first page too large to draw: checked before the room is reserved. */
export function imagesPlan(pages: readonly PagePlan[], sizes: readonly PageInfo[], dpi: number) {
    return pages.map((page, index) => {
        const size = imageSize(sizes[index] ?? { width: 612, height: 792 }, page.rotate, dpi);
        if (
            !Number.isFinite(size.width * size.height) ||
            size.width * size.height > IMAGES_MAX_PIXELS
        )
            throw new PageTooLarge(index + 1);
        return size;
    });
}
