/*
 * Single source of truth for the HushOS mark. `Logo` in components/logo.tsx
 * renders the same paths; `scripts/brand-assets.ts` writes the public files.
 */
export const LOGO_VIEWBOX = '0 0 300 419';
export const LOGO_PATHS = [
    'M66 59C54.9543 59 46 67.9543 46 79V149C46 160.046 54.9543 169 66 169C77.0457 169 86 160.046 86 149V79C86 67.9543 77.0457 59 66 59ZM66 251C54.9543 251 46 259.954 46 271V399C46 410.046 54.9543 419 66 419C77.0457 419 86 410.046 86 399V271C86 259.954 77.0457 251 66 251Z',
    'M140 30C128.954 30 120 38.9543 120 50V135C120 146.046 128.954 155 140 155C151.046 155 160 146.046 160 135V50C160 38.9543 151.046 30 140 30ZM140 265C128.954 265 120 273.954 120 285V370C120 381.046 128.954 390 140 390C151.046 390 160 381.046 160 370V285C160 273.954 151.046 265 140 265Z',
    'M128.915 230C120.444 256.674 95.4788 276 66 276C29.5492 276 0 246.451 0 210C0 173.549 29.5492 144 66 144C95.4788 144 120.444 163.326 128.915 190L280 190C291.046 190 300 198.954 300 210V260C300 271.046 291.046 280 280 280C268.954 280 260 271.046 260 260V230L128.915 230ZM106 210C106 232.091 88.0914 250 66 250C43.9086 250 26 232.091 26 210C26 187.909 43.9086 170 66 170C88.0914 170 106 187.909 106 210Z',
] as const;

function paths(fill: string) {
    return [
        `<path fill-rule="evenodd" clip-rule="evenodd" d="${LOGO_PATHS[0]}" fill="${fill}"/>`,
        `<rect x="194" width="40" height="360" rx="20" fill="${fill}"/>`,
        `<path fill-rule="evenodd" clip-rule="evenodd" d="${LOGO_PATHS[1]}" fill="${fill}"/>`,
        `<path fill-rule="evenodd" clip-rule="evenodd" d="${LOGO_PATHS[2]}" fill="${fill}"/>`,
    ].join('');
}

function backdrop(background: string | undefined, width: number, height: number) {
    return background
        ? `<rect x="-60" y="-60" width="${width + 120}" height="${height + 120}" fill="${background}"/>`
        : '';
}

/* Pass `background` for variants meant for dark surfaces so previews stay legible. */
export function logoSvg(fill = '#000000', background?: string) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 420 539" width="420" height="539" fill="none">${backdrop(background, 300, 419)}${paths(fill)}</svg>`;
}

export function wordmarkSvg(fill = '#000000', background?: string) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 1780 539" width="1780" height="539" fill="none">${backdrop(background, 1660, 419)}${paths(fill)}<text x="390" y="318" fill="${fill}" font-family="Geist Mono Variable, Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace" font-size="270" font-weight="600" letter-spacing="34">HUSHOS</text></svg>`;
}
