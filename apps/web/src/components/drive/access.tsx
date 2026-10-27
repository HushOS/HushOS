import { useQuery } from '@tanstack/react-query';
import { Link2Icon, UsersIcon } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from 'cn';
import type { Access } from '@/components/access-cell';
import { PersonAvatar } from '@/components/person-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { mySharingQueryOptions } from '@/lib/drive';

/*
 * Who can open one's own items, from everything this person shares: the people
 * on each item and the links that open it. A folder that is shared opens to the
 * same people everything inside it, which rows say as "Same as folder".
 */

/* Each shared item of one's own: who has it and how many links open it. */
export function useAccessIndex(enabled: boolean) {
    const mine = useQuery({ ...mySharingQueryOptions, enabled });
    return useMemo(() => {
        const index = new Map<string, Access>();
        const entry = (id: string) => {
            let found = index.get(id);
            if (!found) index.set(id, (found = { people: [], links: 0 }));
            return found;
        };
        for (const share of mine.data?.shares ?? [])
            entry(share.node.id).people.push({ id: share.grantee.id, name: share.grantee.name });
        for (const link of mine.data?.links ?? []) entry(link.node.id).links++;
        return index;
    }, [mine.data]);
}

/*
 * "You, Sam and anyone with the link can open everything in this folder", said
 * of the folder or a folder above it, in the apps' words: it starts with You.
 */
export function accessSentence(access: Access) {
    const names = access.people.map((person) => person.name.trim().split(/\s+/)[0]!);
    const others =
        names.length <= 2
            ? names
            : [
                  ...names.slice(0, 2),
                  `${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'}`,
              ];
    const parts = ['You', ...others, ...(access.links ? ['anyone with the link'] : [])];
    const subject =
        parts.length === 1 ? 'Only you' : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    return `${subject} can open everything in this folder.`;
}

export function AccessBanner({
    text,
    action,
    onAction,
}: {
    text: string;
    action?: string;
    onAction?: () => void;
}) {
    return (
        <div className="mx-5 mb-3 flex min-h-12 shrink-0 items-center gap-3 rounded-xl bg-muted px-4 py-2 sm:mx-8">
            <UsersIcon
                className="size-[18px] shrink-0 text-primary"
                strokeWidth={2}
                aria-hidden="true"
            />
            <span className="min-w-0 flex-1 text-sm">{text}</span>
            {action && (
                <button
                    type="button"
                    onClick={onAction}
                    className="shrink-0 cursor-pointer text-sm font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                >
                    {action}
                </button>
            )}
        </div>
    );
}

/*
 * Who can open a folder one shared, beside its title: up to three avatars, "+N" past
 * them, the blue link icon when a link opens it, and "via Family" when the sharing is a
 * folder above's. The full sentence is its label and its tooltip; it opens the sharing.
 */
export function AccessMarker({
    access,
    via,
    onOpen,
    className,
}: {
    access: Access;
    via?: string | null;
    onOpen: () => void;
    className?: string;
}) {
    const sentence = accessSentence(access) + (via ? ` Shared through “${via}”.` : '');
    const { people, links } = access;
    const more = people.length - 3;
    return (
        <Tooltip>
            <TooltipTrigger
                render={<button type="button" aria-label={sentence} />}
                onClick={onOpen}
                className={cn(
                    'flex shrink-0 cursor-pointer items-center gap-2 rounded-full py-1 pr-2.5 pl-1 text-[13px] text-muted-foreground transition-colors outline-hidden hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
                    className,
                )}
            >
                {people.length > 0 && (
                    <span className="flex shrink-0 -space-x-1.5">
                        {people.slice(0, 3).map((person) => (
                            <PersonAvatar
                                key={person.id}
                                name={person.name}
                                seed={person.id}
                                size={24}
                                className="ring-2 ring-background"
                            />
                        ))}
                    </span>
                )}
                {more > 0 && <span className="tabular-nums">+{more}</span>}
                {links > 0 && (
                    <Link2Icon
                        className="size-3.5 shrink-0 text-primary"
                        strokeWidth={2.4}
                        aria-hidden="true"
                    />
                )}
                {people.length === 0 && links > 0 && <span>Link</span>}
                {via && <span className="truncate">via {via}</span>}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72">
                {sentence}
            </TooltipContent>
        </Tooltip>
    );
}

/* The row's cell lives in access-cell.tsx, which public pages can load without the drive. */
export { AccessCell, type Access } from '@/components/access-cell';
