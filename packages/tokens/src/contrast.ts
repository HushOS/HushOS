/*
 * WCAG 2.x contrast. Colours are opaque #RRGGBB; translucent roles (scrim, edge)
 * depend on what they sit over and are not measured here.
 */

function channel(value: number) {
    const c = value / 255;
    // 0.04045 is the sRGB threshold WCAG 2.2 corrected 0.03928 to; it only affects very dark channels.
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an opaque #RRGGBB colour. */
export function luminance(hex: string) {
    const match = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!match) throw new Error(`Not an opaque #RRGGBB colour: ${hex}`);
    const n = Number.parseInt(match[1]!, 16);
    return (
        0.2126 * channel((n >> 16) & 255) +
        0.7152 * channel((n >> 8) & 255) +
        0.0722 * channel(n & 255)
    );
}

/** Contrast ratio between two opaque colours, from 1 (same) to 21 (black on white). */
export function contrast(a: string, b: string) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}
