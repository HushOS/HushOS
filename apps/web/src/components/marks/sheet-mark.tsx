import { cn } from 'cn';
import type { CSSProperties } from 'react';

/*
 * A file's sheet mark, apart from FileMark so a page that draws one without the drive (the family
 * plans post's demo) doesn't load the thumbnail and download machinery FileMark brings.
 */

/* A file's type colour on its mark (styles.css [data-file-hue]); none keeps the plain sheet. */
export function hueProps(hue: number | null) {
    return hue === null ? {} : { 'data-file-hue': '', style: { '--th': hue } as CSSProperties };
}

/*
 * A white sheet with a turned corner, and the file's type on a label when it has one:
 * in the type's colour, the sheet faintly tinted to match, or ink for a type with none.
 */
export function SheetMark({
    box,
    label,
    hue,
    className,
}: {
    box: number;
    label: string;
    hue: number | null;
    className?: string;
}) {
    const width = box * 0.78;
    const tint = hueProps(hue);
    return (
        <span
            aria-hidden="true"
            data-file-hue={tint['data-file-hue']}
            className={cn('flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box, ...tint.style }}
        >
            <svg width={width} height={width * 1.23} viewBox="0 0 44 54">
                <path
                    d="M4 1h25.6L43 14.4V50a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z"
                    fill="var(--sheet-fill, var(--surface))"
                    stroke="var(--sheet-edge, var(--field))"
                    strokeWidth="2"
                />
                <path
                    d="M29.5 1v10a3.5 3.5 0 0 0 3.5 3.5h10"
                    fill="none"
                    stroke="var(--sheet-edge, var(--field))"
                    strokeWidth="2"
                />
                {label ? (
                    <>
                        <rect
                            x="5"
                            y="34"
                            width={label.length > 3 ? 32 : 27}
                            height="13"
                            rx="3"
                            fill="var(--sheet-label, var(--ink))"
                        />
                        <text
                            x={label.length > 3 ? 21 : 18.5}
                            y="43.5"
                            fontSize={label.length > 3 ? 7.5 : 8.5}
                            fontWeight="700"
                            fill="var(--surface)"
                            textAnchor="middle"
                        >
                            {label}
                        </text>
                    </>
                ) : (
                    <g fill="var(--rule)">
                        <rect x="8" y="22" width="22" height="3" rx="1.5" />
                        <rect x="8" y="29" width="27" height="3" rx="1.5" />
                        <rect x="8" y="36" width="18" height="3" rx="1.5" />
                    </g>
                )}
            </svg>
        </span>
    );
}
