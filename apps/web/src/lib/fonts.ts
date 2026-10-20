import sansLatinExt from '@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2?url';
import { formatMoney } from '@/lib/format';

/*
 * The root preloads Geist's latin file, which holds $, € and £ but not ₹
 * (latin-ext, U+20A0-20C0). A page priced in rupees otherwise finds it needs
 * latin-ext only once it has drawn the price: the ₹ shows in the fallback and
 * swaps a moment later, moving every digit after it. Such a page preloads it
 * too. The range is Geist's latin unicode-range (@fontsource-variable/geist).
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
const inLatin = (text: string) =>
    Array.from(text).every((char) => {
        const point = char.codePointAt(0)!;
        return LATIN.some(([low, high]) => point >= low && point <= high);
    });

export function moneyFontLinks(currency: string) {
    return inLatin(formatMoney(123_456, currency))
        ? []
        : [
              {
                  rel: 'preload',
                  href: sansLatinExt,
                  as: 'font',
                  type: 'font/woff2',
                  crossOrigin: 'anonymous' as const,
              },
          ];
}
