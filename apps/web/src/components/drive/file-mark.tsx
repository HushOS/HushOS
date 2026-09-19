import type { DriveNode } from '@hushos/drive/client';
import { cn } from 'cn';
import { extensionOf } from '@/lib/previews';
import { useThumbnail } from '@/lib/thumbnails';

/*
 * How an item is drawn wherever items are listed: a file is a sheet with its
 * top corner turned and its extension at the foot, a folder is a tabbed
 * folder. The shape is a clip path, which would cut a border off along the
 * diagonal, so the hairline is an outer layer in the rule's colour and the
 * face sits one pixel inside it, clipped the same way.
 */

const SHEET = '[clip-path:polygon(0_0,68%_0,100%_24%,100%_100%,0_100%)]';
const FOLDER = '[clip-path:polygon(0_0,44%_0,54%_18%,100%_18%,100%_100%,0_100%)]';

const SIZES = {
    row: {
        /* The margin makes a file as wide as a folder, so names line up down a list. */
        file: 'mx-[3px] h-[30px] w-6',
        /* A little smaller than its column: a folder's full-width block outweighs a sheet of the same box. */
        folder: 'mx-0.5 h-[21px] w-[26px]',
        extension: 'pb-[3px] text-[7.5px]',
        letters: 4,
    },
    large: {
        file: 'h-[78px] w-[60px]',
        folder: 'h-[60px] w-[75px]',
        extension: 'pb-2.5 text-xs',
        letters: 5,
    },
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
    const scale = SIZES[size];
    if ((node?.kind ?? kind) === 'folder')
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'relative inline-block shrink-0 bg-primary',
                    FOLDER,
                    scale.folder,
                    className,
                )}
            >
                {/* The fill carries some of the blue, so the folder is a shape in the dark theme too, not a wire outline. */}
                <span
                    className={cn(
                        'absolute inset-px bg-[color-mix(in_srgb,var(--primary)_24%,var(--card))]',
                        FOLDER,
                    )}
                >
                    {/* The front cover's top edge, under the tab. */}
                    <span className="absolute inset-x-0 top-[30%] h-px bg-primary/55" />
                </span>
            </span>
        );
    const extension = extensionOf(node?.name ?? name ?? '').slice(0, scale.letters);
    return (
        <span
            aria-hidden="true"
            className={cn('relative inline-block shrink-0 bg-input', SHEET, scale.file, className)}
        >
            <span
                className={cn(
                    'absolute inset-px flex items-end justify-center overflow-hidden bg-muted font-mono leading-none text-muted-foreground lowercase',
                    SHEET,
                    scale.extension,
                )}
            >
                {thumbnail ? (
                    <img
                        src={thumbnail}
                        alt=""
                        draggable={false}
                        className="absolute inset-0 size-full object-cover"
                    />
                ) : (
                    extension
                )}
            </span>
        </span>
    );
}
