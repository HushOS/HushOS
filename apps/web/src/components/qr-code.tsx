import { encode } from 'uqr';
import { LOGO_BAR, LOGO_MARGIN, LOGO_PATHS, LOGO_SIDE, LOGO_WIDTH, logoSvg } from '@/lib/brand';

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
/* The mark's corner radius on logoSvg's 539-unit square, and a dot's radius in modules. */
const MARK_RADIUS = 96;
const DOT = 0.44;
const mark = `data:image/svg+xml;utf8,${encodeURIComponent(logoSvg('#ffffff', '#000000', MARK_RADIUS))}`;

/* uqr's module kinds: the finder squares in the corners and the alignment squares, kept square. */
const POSITION = 2;
const ALIGNMENT = 4;

/*
 * The code's modules and where the mark sits, shared by the drawing on screen and the
 * saved image, so the file a person keeps is the very code they saw scan.
 */
function layout(value: string) {
    const code = encode(value, { ecc: 'H', border: 1 });
    const n = code.size;
    // The mark covers about a quarter of the side; the modules under it are left out.
    const box = Math.round(n * 0.24) | 1;
    const from = (n - box) / 2;
    // Exactly the modules under the mark, no more: every one left out costs error correction.
    const under = (x: number, y: number) =>
        x >= from && x < from + box && y >= from && y < from + box;
    const kept = (visit: (x: number, y: number, square: boolean) => void) =>
        code.data.forEach((row, y) =>
            row.forEach((dark, x) => {
                if (!dark || under(x, y)) return;
                const type = code.types[y]![x];
                visit(x, y, type === POSITION || type === ALIGNMENT);
            }),
        );
    return { n, box, from, kept };
}

export function QrCode({
    value,
    size: fixed = 176,
    cell,
    title,
    kind = 'share',
}: {
    value: string;
    kind?: 'share' | 'recovery';
    size?: number;
    /* Whole pixels a module instead of a fixed size: even module edges, for a camera reading a screen. */
    cell?: number;
    title: string;
}) {
    const { n, box, from, kept } = layout(value);
    const size = cell ? n * cell : fixed;
    // Dots need room to read: under 2.5 pixels a module (a share link at 120px), a code falls back to squares.
    const dots = kind === 'share' && size / n >= 2.5;
    const squares: string[] = [];
    const circles: [number, number][] = [];
    kept((x, y, square) => {
        if (dots && !square) circles.push([x, y]);
        else squares.push(`M${x} ${y}h1v1h-1z`);
    });
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
                <circle key={`${x},${y}`} cx={x + 0.5} cy={y + 0.5} r={DOT} fill="#000000" />
            ))}
            <image href={mark} x={from} y={from} width={box} height={box} />
        </svg>
    );
    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
}

/* Extra white around a saved code, in modules: with the one drawn in, the four that print asks for. */
const MARGIN = 3;

/*
 * A share link's code as a PNG (always in dots: never use it for the recovery kit,
 * whose code stays square), about 1200 pixels a side, drawn straight onto a
 * canvas from the same modules (not by rasterising the SVG, which some browsers
 * refuse to export once an image is drawn into it). Dots, square finders, the
 * mark, and a white margin so it scans on any background. Resolves to null
 * where the browser cannot make the image.
 */
export async function shareQrImage(value: string): Promise<Blob | null> {
    const { n, box, from, kept } = layout(value);
    const side = n + MARGIN * 2;
    const unit = Math.ceil(1200 / side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side * unit;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    kept((x, y, square) => {
        const left = (x + MARGIN) * unit;
        const top = (y + MARGIN) * unit;
        if (square) context.fillRect(left, top, unit, unit);
        else {
            context.beginPath();
            context.arc(left + unit / 2, top + unit / 2, unit * DOT, 0, Math.PI * 2);
            context.fill();
        }
    });
    // The mark as logoSvg draws it: a black rounded square, the white mark centred in it.
    const size = box * unit;
    const scale = size / LOGO_SIDE;
    const origin = (from + MARGIN) * unit;
    context.beginPath();
    context.roundRect(origin, origin, size, size, MARK_RADIUS * scale);
    context.fill();
    context.save();
    context.translate(
        origin + ((LOGO_SIDE - LOGO_WIDTH) / 2) * scale,
        origin + LOGO_MARGIN * scale,
    );
    context.scale(scale, scale);
    context.fillStyle = '#ffffff';
    for (const d of LOGO_PATHS) context.fill(new Path2D(d), 'evenodd');
    // The mark's upright bar, a rect in brand.ts's paths().
    context.beginPath();
    context.roundRect(LOGO_BAR.x, LOGO_BAR.y, LOGO_BAR.width, LOGO_BAR.height, LOGO_BAR.radius);
    context.fill();
    context.restore();
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
