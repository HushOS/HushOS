import type { DriveNode } from '@hushos/drive/client';
import { cn } from 'cn';
import { extensionOf, previewKind } from '@/lib/previews';
import { useThumbnail } from '@/lib/thumbnails';

/*
 * How an item is drawn wherever items are listed. A folder is two solid sheets,
 * the back darker than the front. A file shows what is inside when the app made
 * a thumbnail at upload: a photo as itself, a PDF as its first page with a type
 * badge, a video as a frame with a play badge. Everything else, and anything
 * whose thumbnail is missing, is a white sheet with a turned corner and its type.
 */

const SIZES = {
    /* Compact lists: search results, tags, dialogs. */
    row: 32,
    /* The file browser's rows. */
    list: 36,
    /* Grid tiles and the details panel. */
    large: 72,
} as const;

type FileMarkProps = (
    | { node: DriveNode; kind?: undefined; name?: undefined }
    | { node?: undefined; kind: 'file' | 'folder'; name: string }
) & {
    size?: keyof typeof SIZES;
    className?: string;
};

export function FileMark({ node, kind, name, size = 'row', className }: FileMarkProps) {
    const thumbnail = useThumbnail(node ?? null);
    const box = SIZES[size];
    if ((node?.kind ?? kind) === 'folder') return <FolderMark box={box} className={className} />;
    const preview = node ? previewKind(node) : 'none';
    if (thumbnail && preview === 'pdf')
        return <PageMark box={box} src={thumbnail} className={className} />;
    if (thumbnail)
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'relative flex shrink-0 items-center justify-center overflow-hidden rounded-[22%] bg-muted',
                    className,
                )}
                style={{ width: box, height: box }}
            >
                <img
                    src={thumbnail}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 size-full object-cover"
                />
                {/* A hairline over the picture, so a white image still has an edge on a white row. */}
                <span className="absolute inset-0 rounded-[inherit] ring-1 ring-edge ring-inset" />
                {preview === 'video' && <PlayBadge box={box} />}
            </span>
        );
    return (
        <SheetMark
            box={box}
            label={extensionOf(node?.name ?? name ?? '')
                .slice(0, 4)
                .toUpperCase()}
            className={className}
        />
    );
}

function FolderMark({ box, className }: { box: number; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cn('flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box }}
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

/* A white sheet with a turned corner, and the file's type on a dark label when it has one. */
function SheetMark({ box, label, className }: { box: number; label: string; className?: string }) {
    const width = box * 0.78;
    return (
        <span
            aria-hidden="true"
            className={cn('flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box }}
        >
            <svg width={width} height={width * 1.23} viewBox="0 0 44 54">
                <path
                    d="M4 1h25.6L43 14.4V50a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z"
                    fill="var(--surface)"
                    stroke="var(--field)"
                    strokeWidth="2"
                />
                <path
                    d="M29.5 1v10a3.5 3.5 0 0 0 3.5 3.5h10"
                    fill="none"
                    stroke="var(--field)"
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
                            fill="var(--ink)"
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

/* A PDF's first page, as the app rendered it at upload, with a small type badge. */
function PageMark({ box, src, className }: { box: number; src: string; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cn('relative flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box }}
        >
            <span
                className="overflow-hidden rounded-[8%] border border-rule bg-card shadow-sm"
                style={{ width: box * 0.78, height: box }}
            >
                <img
                    src={src}
                    alt=""
                    draggable={false}
                    className="size-full object-cover object-top"
                />
            </span>
            {box >= 32 && (
                <span
                    className="absolute bottom-[8%] rounded-[3px] bg-ink px-[4%] font-bold text-card"
                    style={{
                        left: box * 0.06,
                        fontSize: Math.max(7, box * 0.16),
                        lineHeight: 1.35,
                    }}
                >
                    PDF
                </span>
            )}
        </span>
    );
}

/* A video frame's play badge. No duration: the app does not store one. */
function PlayBadge({ box }: { box: number }) {
    return (
        <span
            className="relative flex items-center justify-center rounded-full bg-black/45"
            style={{ width: box * 0.42, height: box * 0.42 }}
        >
            <svg width={box * 0.2} height={box * 0.2} viewBox="0 0 24 24" fill="white">
                <path d="M8 5.5v13l11-6.5z" />
            </svg>
        </span>
    );
}
