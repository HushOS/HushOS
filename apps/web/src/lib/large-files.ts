import { COLOUR_CEILING, HIGHLIGHT_LIMIT } from '@/lib/highlight';
import { OFFICE_LIMIT } from '@/lib/office';

/*
 * How much of a file the viewer reads as it opens, and the large-file card's
 * thresholds and ceilings beyond that. Pure, so the rules are tested without
 * a browser; lib/previews.ts re-exports them.
 */

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

/*
 * Past a kind's threshold a file is shown only in part, or not coloured, or
 * not opened, until the person asks (the large-file card, LargeFile in
 * viewer-parts); past its ceiling it isn't offered at all. PDF and media have
 * neither: they stream by range. Everything still decrypts into memory only.
 */
export type LargeFileKind = 'colour' | 'text' | 'image' | 'office';
export type LargeFileStage = 'fine' | 'offer' | 'ceiling';

const MiB = 1024 * 1024;

/*
 * Text loads whole up to 32 MB. The bytes and the decoded string are held
 * together (two to four times the file), the viewer draws it in blocks so the
 * page stays usable, and past this the gain over the first 8 MB rarely
 * outweighs a tab that a phone may kill.
 */
export const TEXT_CEILING = 32 * MiB;
/*
 * Office files and CSV open up to 64 MB. Mammoth and SheetJS parse on the
 * page and keep several copies of what they read (a spreadsheet's XML
 * inflates many times over); at 64 MB a CSV already takes about a gigabyte.
 */
export const OFFICE_CEILING = 64 * MiB;

/*
 * Images open up to 300 MB, less where the browser says the device has little
 * memory (Chromium's navigator.deviceMemory, in GB, capped at 8; Safari and
 * Firefox don't say). The file is held while the browser decodes it, and the
 * decoded picture takes four bytes a pixel, often more than the file.
 */
export type Device = {
    /* navigator.deviceMemory, in GB; undefined where the browser doesn't say. */
    deviceMemory: number | undefined;
    /* Whether the main pointer is a finger. */
    coarse: boolean;
};

/* What this browser says about the device. */
export function thisDevice(): Device {
    if (typeof window === 'undefined') return { deviceMemory: undefined, coarse: false };
    return {
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        coarse:
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(pointer: coarse)').matches,
    };
}

export function imageCeiling({ deviceMemory, coarse }: Device = thisDevice()) {
    if (deviceMemory !== undefined && deviceMemory <= 2) return PREVIEW_LIMITS.image;
    // A touch screen that doesn't say how much memory it has is taken for a phone.
    if (deviceMemory !== undefined ? deviceMemory <= 4 : coarse) return 200 * MiB;
    return 300 * MiB;
}

export function largeFileLimits(kind: LargeFileKind, device: Device = thisDevice()) {
    switch (kind) {
        case 'colour':
            return { threshold: HIGHLIGHT_LIMIT, ceiling: COLOUR_CEILING };
        case 'text':
            return { threshold: PREVIEW_LIMITS.text, ceiling: TEXT_CEILING };
        case 'image':
            return { threshold: PREVIEW_LIMITS.image, ceiling: imageCeiling(device) };
        case 'office':
            return { threshold: OFFICE_LIMIT, ceiling: OFFICE_CEILING };
    }
}

export function largeFileStage(
    kind: LargeFileKind,
    size: number,
    device: Device = thisDevice(),
): LargeFileStage {
    // A size that can't be read (an envelope that won't open) leaves the file to its own
    // error; the read is capped at the limit anyway.
    if (!Number.isFinite(size)) return 'fine';
    const { threshold, ceiling } = largeFileLimits(kind, device);
    if (size <= threshold) return 'fine';
    return size <= ceiling ? 'offer' : 'ceiling';
}
