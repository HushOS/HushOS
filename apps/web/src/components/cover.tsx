import { cn } from 'cn';
import { useId, type CSSProperties } from 'react';
import type { CoverTone } from '@/lib/content';

/*
 * A blog post's cover: one word spelled in dots on a field of faint dots, with
 * a scatter of loose dots around it, the way a locked file looks next to the
 * one you can read. Drawn from the post's own frontmatter (`cover`, `tone`) and
 * seeded by its slug, so a cover never changes between builds and needs no
 * image file. The loose dots flicker while the pointer is on the post.
 */

/* 5×7 glyphs, one string of five bits per row, top to bottom. */
const font: Record<string, string[]> = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/* Field and ink per tone. The covers are artwork, so they keep their colours in the dark. */
export const tones: Record<CoverTone, { field: string; ink: string }> = {
    // The page's own quiet fill and muted ink: texture without a colour of its own. Pages only;
    // the social cards are drawn without the page's variables.
    quiet: { field: 'var(--muted)', ink: 'var(--muted-foreground)' },
    lime: { field: '#e3f671', ink: '#15171c' },
    sun: { field: '#ffcf4a', ink: '#17203a' },
    sage: { field: '#2f4a3e', ink: '#e3ece7' },
    blue: { field: '#2c428e', ink: '#ffffff' },
    orange: { field: '#ffa037', ink: '#15171c' },
    mint: { field: '#c6f0d8', ink: '#15171c' },
    graphite: { field: '#22262e', ink: '#e8e9ed' },
};

const COLS = 48;

/* The 4×4 ordered-dither (Bayer) thresholds, the matrix dither-kit paints with. */
const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16));
const CELL = 10;

/* mulberry32 over a string hash: the same slug draws the same scatter on server and client. */
function random(seed: string) {
    let state = 2166136261;
    for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/*
 * The cells a word lights, as "col,row" keys, centred in the field. A short word
 * is drawn with each of its dots two or three cells wide, so "1.0" fills the
 * cover as well as "OPAQUE" does.
 */
function letterCells(word: string, cols: number, rows: number, high = false) {
    // The font is ASCII only, so splitting by code unit is exact.
    const glyphs = word
        .toUpperCase()
        .split('')
        .map((char) => font[char] ?? font[' ']!);
    const width = glyphs.length * 6 - 1;
    const scale = Math.max(
        1,
        Math.min(3, Math.floor((cols - 8) / width), Math.floor((rows - 4) / 7)),
    );
    const left = Math.max(0, Math.floor((cols - width * scale) / 2));
    // Over a dither wash the word sits in the clear upper part, clear of the dots.
    const top = high ? Math.floor(rows * 0.22) : Math.floor((rows - 7 * scale) / 2);
    const lit = new Set<string>();
    const bottom = top + 7 * scale;
    glyphs.forEach((glyph, index) =>
        glyph.forEach((row, y) =>
            row.split('').forEach((bit, x) => {
                if (bit !== '1') return;
                for (let dy = 0; dy < scale; dy++)
                    for (let dx = 0; dx < scale; dx++)
                        lit.add(`${left + (index * 6 + x) * scale + dx},${top + y * scale + dy}`);
            }),
        ),
    );
    return { lit, bottom };
}

/*
 * The drawing itself, with no hooks, so the server's social cards can draw the
 * same art. `dither` swaps the random scatter for an ordered-dither wash rising
 * from the foot, the texture of dither-kit's gradients.
 */
export function CoverArt({
    word,
    tone = 'blue',
    seed,
    cols = COLS,
    rows = 27,
    dither = false,
    pattern,
    width,
    height,
    fill = false,
    className,
}: {
    word: string;
    tone?: CoverTone;
    seed: string;
    cols?: number;
    /* 27 rows by 48 columns draws a 16:9 card; fewer rows draw a banner. */
    rows?: number;
    dither?: boolean;
    /* The id of the faint grid's pattern, unique on the page. */
    pattern: string;
    width?: number;
    height?: number;
    /* Fill a box of any shape, cropping the art's edges rather than letterboxing it. */
    fill?: boolean;
    className?: string;
}) {
    // A misspelt tone in a post's frontmatter falls back to blue rather than failing the page.
    const { field, ink } = tones[tone] ?? tones.blue;
    const { lit, bottom } = letterCells(word, cols, rows, dither);
    // The wash starts a few rows under the word, however tall the word is drawn.
    const washTop = Math.min(rows - 3, bottom + 2) / rows;
    const next = random(seed);
    const dots: { x: number; y: number; noise: boolean; alpha: number }[] = [];
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const roll = next();
            if (lit.has(`${x},${y}`)) dots.push({ x, y, noise: false, alpha: 1 });
            else if (dither) {
                // Clear around the word, building to dense at the foot.
                const density = (Math.max(0, y / rows - washTop) / (1 - washTop)) * 0.85;
                if (density > BAYER[y & 3]![x & 3]!) dots.push({ x, y, noise: false, alpha: 0.38 });
            } else if (roll < 0.07) dots.push({ x, y, noise: true, alpha: 0.2 + next() * 0.35 });
        }
    return (
        <svg
            viewBox={`0 0 ${cols * CELL} ${rows * CELL}`}
            width={width}
            height={height}
            preserveAspectRatio={fill ? 'xMidYMid slice' : undefined}
            aria-hidden="true"
            className={className}
        >
            {/* The faint grid is one pattern, so a cover is a hundred-odd nodes, not a thousand. */}
            <defs>
                <pattern id={pattern} width={CELL} height={CELL} patternUnits="userSpaceOnUse">
                    <circle cx={CELL / 2} cy={CELL / 2} r={1.1} fill={ink} opacity={0.16} />
                </pattern>
            </defs>
            <rect width="100%" height="100%" fill={field} />
            <rect width="100%" height="100%" fill={`url(#${pattern})`} />
            {dots.map((dot) => (
                <circle
                    key={`${dot.x},${dot.y}`}
                    cx={dot.x * CELL + CELL / 2}
                    cy={dot.y * CELL + CELL / 2}
                    r={3.4}
                    fill={ink}
                    opacity={dot.alpha}
                    className={dot.noise ? 'cover-noise' : undefined}
                    style={
                        dot.noise
                            ? ({
                                  '--alpha': dot.alpha,
                                  '--delay': `${(dot.x * 37 + dot.y * 53) % 900}ms`,
                              } as CSSProperties)
                            : undefined
                    }
                />
            ))}
        </svg>
    );
}

export function Cover({
    word,
    tone,
    seed,
    cols,
    rows,
    dither,
    fill,
    className,
}: {
    word: string;
    tone?: CoverTone;
    seed: string;
    cols?: number;
    rows?: number;
    dither?: boolean;
    fill?: boolean;
    className?: string;
}) {
    const pattern = useId();
    return (
        <CoverArt
            word={word}
            tone={tone}
            seed={seed}
            cols={cols}
            rows={rows}
            dither={dither}
            fill={fill}
            pattern={pattern}
            className={cn('block w-full', fill ? 'h-full' : 'h-auto', className)}
        />
    );
}
