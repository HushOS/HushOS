import { cn } from 'cn';
import { BAYER4, fnv1a, hueFill, xorshift32 } from '@/components/dither-kit/pixel';

/*
 * dither-kit's avatar (components/dither-kit/avatar.tsx) as a still image: the same mirrored 8×8
 * glyph from the same name, drawn into a 32×32 PNG while rendering, so the server's HTML already
 * has it. The vendored one paints a canvas after hydration, blank until then, with an entrance;
 * that suits a moment of motion, not a mark in a list. An <img>, so it is also allowed inside a
 * paragraph, where the vendored <div> breaks the HTML and with it hydration.
 *
 * The model is avatar.tsx's avatarModel with mirror "auto" and the name's own hue; kept in step by
 * hand, since the vendored file is re-copied rather than edited.
 */
const GRID = 8;
const CELL_PX = 4;
const PX = GRID * CELL_PX;

function model(name: string) {
    const rand = xorshift32(fnv1a(name));
    const bits = Array.from({ length: 32 }, () => rand() < 0.5);
    const vertical = rand() < 0.5;
    const hue = Math.floor(rand() * 180) * 2;
    const halfDensity = Array.from({ length: 32 }, () => 0.55 + rand() * 0.45);
    const on: boolean[] = [];
    const density: number[] = [];
    for (let r = 0; r < GRID; r++)
        for (let c = 0; c < GRID; c++) {
            const i = vertical
                ? Math.min(r, GRID - 1 - r) * GRID + c
                : r * (GRID / 2) + Math.min(c, GRID - 1 - c);
            on.push(bits[i]!);
            density.push(halfDensity[i]!);
        }
    return { on, density, fill: hueFill(hue) };
}

/* Each pixel's alpha as avatar.tsx's canvas stores it (one colour, alpha tiers): 0 is clear. */
function alphas(name: string) {
    const { on, density } = model(name);
    const out = new Uint8Array(PX * PX);
    for (let r = 0; r < GRID; r++)
        for (let c = 0; c < GRID; c++) {
            if (!on[r * GRID + c]) continue;
            const d = density[r * GRID + c]!;
            const base = 0.35 + 0.65 * d;
            for (let py = 0; py < CELL_PX; py++)
                for (let px = 0; px < CELL_PX; px++) {
                    const gx = c * CELL_PX + px;
                    const gy = r * CELL_PX + py;
                    const lit = d > BAYER4[gy & 3]![gx & 3]!;
                    out[gy * PX + gx] = Math.round((lit ? base : base * 0.35) * 255);
                }
        }
    return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes: Uint8Array) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
function chunk(type: string, data: number[] | Uint8Array) {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/*
 * An indexed PNG: palette entry 0 clear, then one entry per alpha tier of the one colour (a few
 * dozen), rows unfiltered in a single stored deflate block. About 1.7 kB, the same bytes on the
 * server and in the browser, with nothing to load.
 */
function png(name: string) {
    const fill = model(name).fill;
    const pixels = alphas(name);
    const tiers = [0, ...new Set([...pixels].filter((a) => a > 0))];
    const index = new Map(tiers.map((a, i) => [a, i]));
    const raw = new Uint8Array(PX * (PX + 1));
    for (let y = 0; y < PX; y++)
        for (let x = 0; x < PX; x++) raw[y * (PX + 1) + 1 + x] = index.get(pixels[y * PX + x]!)!;
    let a = 1;
    let b = 0;
    for (const byte of raw) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    const zlib = [
        0x78,
        0x01,
        0x01,
        raw.length & 0xff,
        raw.length >>> 8,
        ~raw.length & 0xff,
        (~raw.length >>> 8) & 0xff,
        ...raw,
        ...u32(((b << 16) | a) >>> 0),
    ];
    const bytes = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...chunk('IHDR', [...u32(PX), ...u32(PX), 8, 3, 0, 0, 0]),
        ...chunk(
            'PLTE',
            tiers.flatMap(() => fill),
        ),
        ...chunk('tRNS', tiers),
        ...chunk('IDAT', zlib),
        ...chunk('IEND', []),
    ];
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/png;base64,${btoa(binary)}`;
}

/*
 * The last few drawn, most recent last: the roadmap's handful of areas stay, while names that
 * come from people (an inviter's) cannot grow it for the life of the server.
 */
const DRAWN_MAX = 256;
const drawn = new Map<string, string>();
export function ditherMarkSrc(name: string) {
    let src = drawn.get(name);
    if (src) drawn.delete(name);
    else src = png(name);
    drawn.set(name, src);
    if (drawn.size > DRAWN_MAX) drawn.delete(drawn.keys().next().value!);
    return src;
}

/*
 * A still dither-kit avatar, for marks beside text. Decoration unless given a label: the words
 * next to it already say what it stands for.
 */
export function DitherMark({
    name,
    size,
    label,
    className,
}: {
    name: string;
    size: number;
    label?: string;
    className?: string;
}) {
    return (
        <img
            src={ditherMarkSrc(name)}
            width={size}
            height={size}
            alt={label ?? ''}
            aria-hidden={label ? undefined : true}
            draggable={false}
            className={cn('inline-block shrink-0 [image-rendering:pixelated]', className)}
        />
    );
}
