import sansLatinExt from '@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2?url';
import { formatMoney } from '@/lib/format';

/*
 * The root preloads Geist's latin file, which holds $, € and £ but not ₹
 * (latin-ext, U+20A0-20C0). A page priced in rupees otherwise finds it needs
 * latin-ext only once it has drawn the price: the ₹ shows in the fallback and
 * swaps a moment later, moving every digit after it. Such a page preloads it
 * too, when latin-ext has the glyph. The ranges are Geist's latin and latin-ext
 * unicode-ranges from @fontsource-variable/geist 5.3.0's index.css: check them
 * again when that package is upgraded.
 */
const LATIN: [number, number][] = [
    [0x0000, 0x00ff],
    [0x0131, 0x0131],
    [0x0152, 0x0153],
    [0x02bb, 0x02bc],
    [0x02c6, 0x02c6],
    [0x02da, 0x02da],
    [0x02dc, 0x02dc],
    [0x0304, 0x0304],
    [0x0308, 0x0308],
    [0x0329, 0x0329],
    [0x2000, 0x206f],
    [0x20ac, 0x20ac],
    [0x2122, 0x2122],
    [0x2191, 0x2191],
    [0x2193, 0x2193],
    [0x2212, 0x2212],
    [0x2215, 0x2215],
    [0xfeff, 0xfeff],
    [0xfffd, 0xfffd],
];
const LATIN_EXT: [number, number][] = [
    [0x0100, 0x02ba],
    [0x02bd, 0x02c5],
    [0x02c7, 0x02cc],
    [0x02ce, 0x02d7],
    [0x02dd, 0x02ff],
    [0x0304, 0x0304],
    [0x0308, 0x0308],
    [0x0329, 0x0329],
    [0x1d00, 0x1dbf],
    [0x1e00, 0x1e9f],
    [0x1ef2, 0x1eff],
    [0x2020, 0x2020],
    [0x20a0, 0x20ab],
    [0x20ad, 0x20c0],
    [0x2113, 0x2113],
    [0x2c60, 0x2c7f],
    [0xa720, 0xa7ff],
];
const within = (ranges: [number, number][], point: number) =>
    ranges.some(([low, high]) => point >= low && point <= high);
/* Whether drawing `text` takes Geist's latin-ext file: a glyph latin lacks and latin-ext has. */
const needsLatinExt = (text: string) =>
    Array.from(text).some((char) => {
        const point = char.codePointAt(0)!;
        return !within(LATIN, point) && within(LATIN_EXT, point);
    });

/* For a page that draws prices in these currencies (repeats and blanks are fine). */
export function moneyFontLinks(...currencies: (string | null | undefined)[]) {
    return currencies.some((currency) => currency && needsLatinExt(formatMoney(123_456, currency)))
        ? [
              {
                  rel: 'preload',
                  href: sansLatinExt,
                  as: 'font',
                  type: 'font/woff2',
                  crossOrigin: 'anonymous' as const,
              },
          ]
        : [];
}
