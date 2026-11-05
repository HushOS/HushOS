import { fileTypeHue, folderColour, type DriveNode } from '@hushos/drive/client';
import { cn } from 'cn';
import { FolderMark } from '@/components/folder-mark';
import { hueProps, SheetMark } from '@/components/sheet-mark';
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
    if ((node?.kind ?? kind) === 'folder')
        return (
            <FolderMark
                box={box}
                colour={(node && folderColour(node)) ?? undefined}
                className={className}
            />
        );
    const preview = node ? previewKind(node) : 'none';
    const hue = fileTypeHue(node?.name ?? name ?? '');
    if (thumbnail && preview === 'pdf')
        return <PageMark box={box} src={thumbnail} hue={hue} className={className} />;
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
            hue={hue}
            className={className}
        />
    );
}

/* A PDF's first page, as the app rendered it at upload, with a small type badge in its type's colour. */
function PageMark({
    box,
    src,
    hue,
    className,
}: {
    box: number;
    src: string;
    hue: number | null;
    className?: string;
}) {
    const tint = hueProps(hue);
    return (
        <span
            aria-hidden="true"
            data-file-hue={tint['data-file-hue']}
            className={cn('relative flex shrink-0 items-center justify-center', className)}
            style={{ width: box, height: box, ...tint.style }}
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
                    className="absolute bottom-[8%] rounded-[3px] bg-[var(--sheet-label,var(--ink))] px-[4%] font-bold text-card"
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
