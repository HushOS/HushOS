import type { Tag, TagColour, TagRegistry } from '@hushos/drive/client';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState, type CSSProperties } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { tagById, tagInk } from '@/lib/tags';

/*
 * A tag beside a name: a small chip in the tag's own solid colour with text
 * that reads on it, and a rim a shade deeper than the fill so a pale tag
 * still has an edge on the sheet.
 */
export function TagStamp({
    name,
    colour,
    className,
}: {
    name: string;
    colour: TagColour | null;
    className?: string;
}) {
    const ink = tagInk(colour);
    return (
        <span
            style={{ '--tag': ink.fill, '--tag-text': ink.text } as CSSProperties}
            className={cn(
                'inline-flex h-[18px] shrink-0 items-center rounded-xs border border-[color-mix(in_oklab,var(--tag)_82%,black)] bg-(--tag) px-1.5 text-[11px] leading-none font-semibold text-(--tag-text)',
                className,
            )}
        >
            <span className="max-w-32 truncate">{name}</span>
        </span>
    );
}

/* A stamp that opens its tag's page; a click on it is its own, not the row's. */
function StampLink({ tag }: { tag: Tag }) {
    return (
        <Link
            to="/app/tags/$tagId"
            params={{ tagId: tag.id }}
            aria-label={`Tag ${tag.name}`}
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex outline-none focus-visible:[&>span]:outline-2 focus-visible:[&>span]:outline-offset-1 focus-visible:[&>span]:outline-ring hover:[&>span]:-translate-y-px [&>span]:transition-transform [&>span]:duration-100"
        >
            <TagStamp name={tag.name} colour={tag.colour} />
        </Link>
    );
}

/*
 * A row's tags: a few stamps and a count for the rest, so the name always
 * keeps its width. The count opens, on hover, focus or a tap, a note of every
 * tag on the item as a column of stamps, each a link, with a way to change
 * them and a way to the registry. Everything comes from the registry; an id
 * it no longer knows shows nothing.
 */
export function TagStamps({
    tagIds,
    registry,
    itemName,
    onEdit,
    max = 2,
    className,
}: {
    tagIds: string[];
    registry: TagRegistry | null | undefined;
    itemName: string;
    onEdit?: (() => void) | undefined;
    max?: number;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const tags = tagIds.flatMap((id) => {
        const tag = tagById(registry, id);
        return tag ? [tag] : [];
    });
    if (!tags.length) return null;
    const shown = tags.slice(0, max);
    const rest = tags.slice(max);
    return (
        <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
            {shown.map((tag) => (
                <StampLink key={tag.id} tag={tag} />
            ))}
            {rest.length > 0 && (
                <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger
                        openOnHover
                        aria-label={`All ${tags.length} tags`}
                        onClick={(event) => {
                            // A click opens and keeps it open; hover already opened it, so the default would toggle it shut.
                            event.stopPropagation();
                            event.preventBaseUIHandler();
                            setOpen(true);
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        className="inline-flex h-[18px] shrink-0 cursor-pointer items-center rounded-xs border border-input bg-muted px-1.5 text-[11px] leading-none font-semibold text-foreground tabular-nums outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-open:bg-accent data-open:text-accent-foreground"
                    >
                        +{rest.length}
                    </PopoverTrigger>
                    <PopoverContent className="flex w-60 flex-col p-0">
                        <p className="eyebrow truncate border-b border-rule px-3 py-2.5 text-muted-foreground">
                            {tags.length} tags on “{itemName}”
                        </p>
                        <div className="flex flex-col items-start gap-1 px-3 py-2">
                            {tags.map((tag) => (
                                <StampLink key={tag.id} tag={tag} />
                            ))}
                        </div>
                        <div className="flex items-center justify-between gap-3 border-t border-rule px-3 py-2">
                            {onEdit ? (
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setOpen(false);
                                        onEdit();
                                    }}
                                    className="text-link cursor-pointer text-xs"
                                >
                                    Edit tags
                                </button>
                            ) : (
                                <span />
                            )}
                            <Link
                                to="/app/tags"
                                onClick={(event) => event.stopPropagation()}
                                className="text-link text-xs"
                            >
                                Manage tags
                            </Link>
                        </div>
                    </PopoverContent>
                </Popover>
            )}
        </span>
    );
}
