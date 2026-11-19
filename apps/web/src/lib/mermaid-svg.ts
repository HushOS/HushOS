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

/* A URL anywhere in a value, other than a fragment within the SVG itself. */
const OUTSIDE_URL = /url\(\s*(?!['"]?#)/i;
const SCRIPTED = /javascript:|expression\(|@import|behavior:/i;

/*
 * Whether pele's SVG may be shown: every tag is one of pele's elements and carries only allowlisted,
 * quoted attributes whose values name nothing outside the SVG. Text between tags is pele's escaped
 * text and is never read as markup.
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
        const leftover = rest.replace(attribute, (_, key: string, value: string) => {
            if (!ATTRIBUTES.has(key) || OUTSIDE_URL.test(value) || SCRIPTED.test(value))
                return '\u0000';
            return '';
        });
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
