/*
 * A folder's colour. It lives in the folder's sealed metadata as the `colour`
 * attribute, always a lowercase `#rrggbb`, never a preset's name: a colour
 * outlives any change to the presets, and no client needs a list to read it.
 * Everyone who can open the folder sees it; anyone who can rename it can
 * change it. Clients draw it at their own lightness for each theme, so only
 * its hue and how vivid it is carry over.
 *
 * A folder with no colour, or one this client cannot read, shows a default
 * worked out from its id, the same on every device (the Rust core keeps the
 * twin of these rules: crates/hushos-core/src/colour.rs).
 */

export const COLOUR_ATTRIBUTE = 'colour';

/* The swatches offered for a folder, and the colours a new folder starts with. */
export const FOLDER_COLOURS = [
    '#70adfb',
    '#53c48e',
    '#f28881',
    '#aa9cf7',
    '#00c3cb',
    '#e488be',
    '#8fbb5f',
    '#e99355',
] as const;

const COLOUR = /^#[0-9a-f]{6}$/;

export function isColour(value: unknown): value is string {
    return typeof value === 'string' && COLOUR.test(value);
}

/* A colour a person typed or picked, as it is stored, or null when it is not one. */
export function toColour(value: string): string | null {
    const lower = value.trim().toLowerCase();
    return COLOUR.test(lower) ? lower : null;
}

/* FNV-1a over the id's UTF-8 bytes: small, and simple to keep identical in Rust. */
function fnv1a(text: string) {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

export function defaultFolderColour(id: string): string {
    return FOLDER_COLOURS[fnv1a(id) % FOLDER_COLOURS.length]!;
}

/* The colour a folder is drawn in: its own, or its default when it has none it can use. */
export function folderColour(node: {
    id: string;
    metadata?: { attributes?: Record<string, string> } | null;
}): string {
    const own = node.metadata?.attributes?.[COLOUR_ATTRIBUTE];
    return isColour(own) ? own : defaultFolderColour(node.id);
}

/* A new folder's colour: one of the swatches, at random. */
export function randomFolderColour(random: () => number = Math.random): string {
    const index = Math.min(FOLDER_COLOURS.length - 1, Math.floor(random() * FOLDER_COLOURS.length));
    return FOLDER_COLOURS[index]!;
}

/*
 * A colour's OKLCH hue in degrees and how vivid it is, from 0 (grey) to 1 (as
 * vivid as the swatches), for drawing it at each theme's own lightness.
 */
export function colourHue(colour: string): { hue: number; strength: number } {
    const n = Number.parseInt(colour.slice(1), 16);
    const linear = (value: number) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = linear((n >> 16) & 255);
    const g = linear((n >> 8) & 255);
    const b = linear(n & 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return {
        hue: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
        strength: Math.min(1, Math.hypot(A, B) / 0.12),
    };
}
