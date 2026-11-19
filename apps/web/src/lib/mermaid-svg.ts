/*
 * Mermaid diagrams in Markdown (docs/editing-design.md, "Diagrams"), drawn by pele from someone's
 * file: untrusted input. The SVG never becomes live DOM. It is shown as an <img> from a blob URL,
 * where it runs no script and fetches nothing, and before that it must pass this allowlist: pele's
 * own elements and attributes, no links, no images, no URLs but a fragment, no comments or
 * processing instructions. Anything else and the diagram is not drawn at all. No imports here:
 * the renderer, its worker and the tests share it.
 */

/* The most of a diagram's source pele is given, in characters. */
export const DIAGRAM_SOURCE_LIMIT = 20_000;
/* The most edges a diagram may have; more is a diagram too large to draw. */
export const DIAGRAM_EDGE_LIMIT = 500;
/* The most SVG pele may write for one diagram, in characters. */
export const DIAGRAM_OUTPUT_LIMIT = 2_000_000;
/* The most diagrams drawn in one file; the rest stay code. */
export const DIAGRAMS_PER_DOCUMENT = 20;

/* Why a diagram stays code. */
export type DiagramFailure = 'unsupported' | 'too-large' | 'failed' | 'too-many';

export const diagramWords: Record<DiagramFailure, string> & { alt: string } = {
    unsupported: 'This kind of diagram isn’t drawn here.',
    'too-large': 'This diagram is too large to draw.',
    failed: 'This diagram couldn’t be drawn.',
    'too-many': `Only the first ${DIAGRAMS_PER_DOCUMENT} diagrams in a file are drawn.`,
    alt: 'Diagram',
};

const ELEMENTS = new Set([
    'svg',
    'g',
    'path',
    'polygon',
    'polyline',
    'line',
    'rect',
    'circle',
    'ellipse',
    'text',
    'tspan',
    'title',
    'desc',
]);

const ATTRIBUTES = new Set([
    'xmlns',
    'class',
    'viewBox',
    'width',
    'height',
    'style',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-opacity',
    'opacity',
    'role',
    'aria-roledescription',
    'aria-label',
    'data-id',
    'd',
    'points',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'dx',
    'dy',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'transform',
    'font-size',
    'font-weight',
    'font-style',
    'font-family',
    'text-anchor',
    'dominant-baseline',
    'xml:space',
]);

/* The properties pele writes in a style attribute (its own custom properties, and these). */
const STYLE_PROPERTIES = new Set([
    'color',
    'direction',
    'dominant-baseline',
    'fill',
    'fill-opacity',
    'font',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'height',
    'letter-spacing',
    'max-width',
    'opacity',
    'rx',
    'ry',
    'stroke',
    'stroke-dasharray',
    'stroke-opacity',
    'stroke-width',
    'text-anchor',
    'text-decoration',
    'text-transform',
    'white-space',
    'width',
    'word-spacing',
]);
const CUSTOM_PROPERTY = /^--(?:_|pele-)[\w-]*$/;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/*
 * An attribute value as an SVG reader sees it: XML character references decoded. Null for a
 * reference XML doesn't define (an SVG file has no other named entities without a DTD, which is
 * refused anyway), so nothing reads differently here and there.
 */
export function decodeAttribute(value: string): string | null {
    let failed = false;
    const decoded = value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, body: string) => {
        if (!match.endsWith(';')) {
            failed = true;
            return '';
        }
        if (body[0] === '#') {
            const code =
                body[1] === 'x' || body[1] === 'X'
                    ? Number.parseInt(body.slice(2), 16)
                    : Number.parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code > 0x10ffff) {
                failed = true;
                return '';
            }
            return String.fromCodePoint(code);
        }
        const named = NAMED[body.toLowerCase()];
        if (named === undefined) failed = true;
        return named ?? '';
    });
    return failed ? null : decoded;
}

/* A CSS value as the CSS parser reads it: escapes (a backslash and hex digits, or a backslash and a character) decoded. */
export function decodeCss(value: string): string {
    return value.replace(
        /\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([\s\S])/gi,
        (_, hex: string | undefined, char: string | undefined) =>
            hex
                ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff) || 0xfffd)
                : (char ?? ''),
    );
}

/*
 * Whether a decoded CSS value reaches nothing outside the SVG: url() only to a fragment, and none of
 * CSS's other ways to name a resource or run anything. CSS comments are refused outright: they could
 * split a function name the checks look for.
 */
function cssValueSafe(value: string) {
    const lower = value.toLowerCase();
    if (/\/\*|\\|[<>]/.test(lower)) return false;
    if (
        /(?:image-set|image|cross-fade|element|paint|src)\s*\(|expression|javascript:|@import|behavior/.test(
            lower,
        )
    )
        return false;
    for (const call of lower.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/g))
        if (!call[2]!.startsWith('#')) return false;
    // A url( the pattern above couldn't read (unbalanced quotes): refused.
    return (
        (lower.match(/url\s*\(/g) ?? []).length ===
        [...lower.matchAll(/url\s*\(\s*(['"]?)#/g)].length
    );
}

/* A style attribute of pele's properties only, each with a safe value. */
function styleSafe(style: string) {
    const css = decodeCss(style);
    for (const declaration of css.split(';')) {
        if (!declaration.trim()) continue;
        const colon = declaration.indexOf(':');
        if (colon < 0) return false;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        if (!STYLE_PROPERTIES.has(property) && !CUSTOM_PROPERTY.test(property)) return false;
        if (!cssValueSafe(declaration.slice(colon + 1))) return false;
    }
    return true;
}

/* One attribute's value, decoded as an SVG reader and its CSS would read it. */
function attributeSafe(key: string, raw: string) {
    const value = decodeAttribute(raw);
    if (value === null) return false;
    if (key === 'style') return styleSafe(value);
    return cssValueSafe(decodeCss(value));
}

/*
 * Whether pele's SVG may be shown: every tag is one of pele's elements and carries only allowlisted,
 * quoted attributes whose values, decoded as the SVG and its CSS read them, name nothing outside the
 * SVG; a style carries only the properties pele writes. Text between tags is pele's escaped text and
 * is never read as markup. Runs in the diagram worker, which has no DOM: the decoding is done here.
 */
export function safeDiagramSvg(svg: string): boolean {
    if (!svg.startsWith('<svg') || /<[!?]/.test(svg)) return false;
    const tag = /<(\/?)([^\s/>]+)([^>]*)>/g;
    let seen = 0;
    for (const match of svg.matchAll(tag)) {
        seen++;
        const [, closing, name, rest] = match as unknown as [string, string, string, string];
        if (!ELEMENTS.has(name)) return false;
        if (closing) {
            if (rest.trim()) return false;
            continue;
        }
        // Every attribute quoted and allowlisted; anything left over (an unquoted value, a stray
        // token) is refused.
        const attribute = /\s+([^\s=/>]+)\s*=\s*"([^"]*)"/g;
        const leftover = rest.replace(attribute, (_, key: string, value: string) =>
            ATTRIBUTES.has(key) && attributeSafe(key, value) ? '' : '\u0000',
        );
        if (!/^\s*\/?\s*$/.test(leftover)) return false;
    }
    return seen > 0;
}

/* Colours from the app's tokens, as pele's --pele-* variables take them. */
export type DiagramPalette = {
    background: string;
    foreground: string;
    muted: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    accent: string;
};

/* A colour as CSS writes one, and nothing that could close the rule or reach outside. */
const COLOUR = /^[#\w\s(),.%/+-]{1,80}$/;

/*
 * The diagram in the app's colours: pele reads --pele-* variables on its root, and an image never
 * sees the page's, so they are written into the SVG itself. A value that isn't plainly a colour is
 * left out, and pele's own default stands.
 */
export function themedSvg(svg: string, palette: DiagramPalette) {
    const variables: [string, string][] = [
        ['--pele-bg', palette.background],
        ['--pele-fg', palette.foreground],
        ['--pele-muted', palette.muted],
        ['--pele-line', palette.foreground],
        ['--pele-surface', palette.surface],
        ['--pele-surface-alt', palette.surfaceAlt],
        ['--pele-border', palette.border],
        ['--pele-accent', palette.accent],
        ['--pele-font', 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'],
        ['--pele-font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'],
    ];
    const rule = variables
        .filter(([, value]) => COLOUR.test(value) && !/url|expression/i.test(value))
        .map(([name, value]) => `${name}:${value.trim()}`)
        .join(';');
    const open = svg.indexOf('>');
    if (open < 0) return svg;
    return `${svg.slice(0, open + 1)}<style>:root{${rule}}</style>${svg.slice(open + 1)}`;
}
