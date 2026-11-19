/*
 * Where each image goes on its page (docs/file-tools-design.md, feature (b)). Page size: Fit to
 * each image (a pixel to a point, scaled down past the 200 inches most readers accept), A4 or
 * US Letter, each turned to match a wider-than-tall image; margins none or 12 mm. The image
 * fits inside the margins, centred, larger or smaller as needed.
 *
 * The matrix draws the image as stored, so an EXIF orientation other than upright is applied
 * by rotating or flipping on the page, never by re-encoding. Twin of `page_layout` in
 * crates/hushos-core/src/images_pdf.rs; both are held to e2e/fixtures/images/geometry.json.
 */

export type PageSize = 'fit' | 'a4' | 'letter';

export type PageLayout = {
    width: number;
    height: number;
    /* [a, b, c, d, e, f]: the unit square of the stored image onto the page. */
    matrix: [number, number, number, number, number, number];
};

const PT_PER_MM = 72 / 25.4;
export const MARGIN_PT = 12 * PT_PER_MM;
/* The largest page side most readers accept (Acrobat's limit), in points. */
const FIT_MAX = 14_400;
const PAPER = { a4: [210 * PT_PER_MM, 297 * PT_PER_MM], letter: [612, 792] } as const;

/*
 * For each orientation, where a stored point (s, t) of the unit square shows, y up:
 * (dX/ds, dX/dt, X at 0, dY/ds, dY/dt, Y at 0). EXIF's 2 to 8 are mirror, 180, flip, transpose,
 * 90 clockwise, transverse and 90 anticlockwise.
 */
const AXES = [
    [1, 0, 0, 0, 1, 0],
    [-1, 0, 1, 0, 1, 0],
    [-1, 0, 1, 0, -1, 1],
    [1, 0, 0, 0, -1, 1],
    [0, -1, 1, -1, 0, 1],
    [0, 1, 0, -1, 0, 1],
    [0, 1, 0, 1, 0, 0],
    [0, -1, 1, 1, 0, 0],
] as const;

export function pageLayout(
    width: number,
    height: number,
    orientation: number,
    size: PageSize,
    margin: boolean,
): PageLayout {
    const m = margin ? MARGIN_PT : 0;
    const o =
        Number.isInteger(orientation) && orientation >= 1 && orientation <= 8 ? orientation : 1;
    const [shownW, shownH] = o >= 5 ? [height, width] : [width, height];
    let pageW: number, pageH: number, boxW: number, boxH: number, x: number, y: number;
    if (size === 'fit') {
        const longest = Math.max(shownW, shownH);
        const scale = longest + 2 * m > FIT_MAX ? (FIT_MAX - 2 * m) / longest : 1;
        boxW = shownW * scale;
        boxH = shownH * scale;
        pageW = boxW + 2 * m;
        pageH = boxH + 2 * m;
        x = m;
        y = m;
    } else {
        let [w, h] = PAPER[size];
        if (shownW > shownH) [w, h] = [h, w];
        const scale = Math.min((w - 2 * m) / shownW, (h - 2 * m) / shownH);
        boxW = shownW * scale;
        boxH = shownH * scale;
        pageW = w;
        pageH = h;
        x = (w - boxW) / 2;
        y = (h - boxH) / 2;
    }
    const [xs, xt, x0, ys, yt, y0] = AXES[o - 1]!;
    return {
        width: pageW,
        height: pageH,
        matrix: [boxW * xs, boxH * ys, boxW * xt, boxH * yt, x + boxW * x0, y + boxH * y0],
    };
}

/* Letter where the browser's locale region is the US or Canada, A4 everywhere else. */
export function defaultPageSize(locales: readonly string[] = navigatorLocales()): 'a4' | 'letter' {
    for (const tag of locales) {
        let region: string | undefined;
        try {
            region = new Intl.Locale(tag).maximize().region;
        } catch {
            continue;
        }
        if (region) return region === 'US' || region === 'CA' ? 'letter' : 'a4';
    }
    return 'a4';
}

function navigatorLocales(): readonly string[] {
    if (typeof navigator === 'undefined') return [];
    return navigator.languages?.length ? navigator.languages : [navigator.language];
}
