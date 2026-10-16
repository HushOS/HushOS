import { encode } from 'uqr';
import { logoSvg } from '@/lib/brand';

/*
 * A QR code with the HushOS mark in the middle, so a code from this app is
 * recognisable as one: the white mark on a black rounded square, the mark's
 * own portrait centred. What a code holds is said beside it, never by the mark.
 *
 * Share links are drawn in dots, the site's dot-matrix look; the three finder
 * squares stay square so cameras lock on, and error correction is H, so the
 * mark and the round modules cost nothing in reading. The recovery kit keeps
 * square modules: it is printed small with all 24 words in it, and it is the
 * one code that has to scan every time.
 */
const mark = `data:image/svg+xml;utf8,${encodeURIComponent(logoSvg('#ffffff', '#000000', 96))}`;

/* uqr's module kinds: the finder squares in the corners and the alignment squares, kept square. */
const POSITION = 2;
const ALIGNMENT = 4;

export function QrCode({
    value,
    size = 176,
    title,
    kind = 'share',
}: {
    value: string;
    kind?: 'share' | 'recovery';
    size?: number;
    title: string;
}) {
    const code = encode(value, { ecc: 'H', border: 1 });
    const n = code.size;
    // The mark covers about a quarter of the side; the modules under it are left out.
    const box = Math.round(n * 0.24) | 1;
    const from = (n - box) / 2;
    // Exactly the modules under the mark, no more: every one left out costs error correction.
    const under = (x: number, y: number) =>
        x >= from && x < from + box && y >= from && y < from + box;
    // Dots need room to read: under 2.5 pixels a module (a share link at 120px), a code falls back to squares.
    const dots = kind === 'share' && size / n >= 2.5;
    const squares: string[] = [];
    const circles: [number, number][] = [];
    code.data.forEach((row, y) =>
        row.forEach((dark, x) => {
            if (!dark || under(x, y)) return;
            const type = code.types[y]![x];
            if (dots && type !== POSITION && type !== ALIGNMENT) circles.push([x, y]);
            else squares.push(`M${x} ${y}h1v1h-1z`);
        }),
    );
    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- drawn inline so the dots stay crisp; role=img reads its title as one image */
    return (
        <svg
            viewBox={`0 0 ${n} ${n}`}
            width={size}
            height={size}
            role="img"
            shapeRendering={dots ? undefined : 'crispEdges'}
        >
            <title>{title}</title>
            <rect width={n} height={n} fill="#ffffff" />
            <path d={squares.join('')} fill="#000000" />
            {circles.map(([x, y]) => (
                <circle key={`${x},${y}`} cx={x + 0.5} cy={y + 0.5} r={0.44} fill="#000000" />
            ))}
            <image href={mark} x={from} y={from} width={box} height={box} />
        </svg>
    );
    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
}
