import { colourHue } from '@hushos/drive/client';
import { cn } from 'cn';
import type { CSSProperties } from 'react';

/*
 * A folder: two solid sheets, the back darker than the front (DESIGN.md → Shapes).
 * With `colour` (a folder's own, see @hushos/drive colour.ts) the sheets take its
 * hue at the theme's folder steps (styles.css); without, the plain folder tokens.
 */
export function FolderMark({
    box,
    colour,
    className,
}: {
    box: number;
    colour?: string;
    className?: string;
}) {
    const tint = folderTint(colour);
    return (
        <span
            aria-hidden="true"
            data-folder-colour={tint['data-folder-colour']}
            className={cn('flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box, ...tint.style }}
        >
            <svg width={box} height={box * 0.82} viewBox="0 0 56 46">
                <path
                    d="M0 6a6 6 0 0 1 6-6h14l6 6h24a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V6Z"
                    fill="var(--folder-back)"
                />
                <path
                    d="M0 14a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V14Z"
                    fill="var(--folder-front)"
                />
            </svg>
        </span>
    );
}

/*
 * What puts an element in a folder's own colour (styles.css [data-folder-colour]): its
 * --folder-front and --folder-back for the folder mark, and for anything else drawn in
 * the folder's colour, such as its row as a drop target. None is the plain folder colour.
 */
export function folderTint(colour: string | null | undefined): {
    'data-folder-colour'?: '';
    style?: CSSProperties;
} {
    if (!colour) return {};
    const { hue, strength } = colourHue(colour);
    return {
        'data-folder-colour': '',
        style: { '--fh': hue.toFixed(1), '--fs': strength.toFixed(3) } as CSSProperties,
    };
}

/* A swatch for a colour in a picker: the colour at a folder front's weight, the same in every theme. */
export function swatchColour(colour: string) {
    const { hue, strength } = colourHue(colour);
    return `oklch(0.74 ${(0.13 * strength).toFixed(3)} ${hue.toFixed(1)})`;
}
