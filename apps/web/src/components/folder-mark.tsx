import { cn } from 'cn';

/* A folder: two solid sheets, the back darker than the front (DESIGN.md → Shapes). */
export function FolderMark({ box, className }: { box: number; className?: string }) {
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
