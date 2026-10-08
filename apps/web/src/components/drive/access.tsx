import { useQuery } from '@tanstack/react-query';
import { Link2Icon, UsersIcon } from 'lucide-react';
import { useMemo } from 'react';
import { PersonAvatar } from '@/components/person-avatar';
import { mySharingQueryOptions } from '@/lib/drive';

/*
 * Who can open one's own items, from everything this person shares: the people
 * on each item and the links that open it. A folder that is shared opens to the
 * same people everything inside it, which rows say as "Same as folder".
 */

export type Access = { people: { id: string; name: string }[]; links: number };

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

/* "You, Sam and anyone with the link": who can open it, said in full. */
function whoCanOpen({ people, links }: Access) {
    const parts = ['You', ...people.map((person) => person.name)];
    if (links > 0) parts.push('anyone with the link');
    return parts.length === 1 ? 'Only you' : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/*
 * A row's "Who can open": the people and the link on it, or what it inherits, or
 * only you. In a detail panel (`detail`) it is the whole sentence, wrapping, with
 * no amber icon: there is room to say it, and the icon is for rows short of it.
 */
export function AccessCell({
    access,
    inherited,
    detail = false,
}: {
    access: Access | undefined;
    inherited: boolean;
    detail?: boolean;
}) {
    if (access && detail)
        return <span className="text-[13px] leading-snug text-pretty">{whoCanOpen(access)}</span>;
    if (!access)
        return (
            <span className="text-[13px] text-muted-foreground">
                {inherited ? 'Same as folder' : 'Only you'}
            </span>
        );
    const { people, links } = access;
    return (
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
            {people.length > 0 && (
                <span className="flex shrink-0 -space-x-1.5">
                    {people.slice(0, 3).map((person) => (
                        <PersonAvatar
                            key={person.id}
                            name={person.name}
                            seed={person.id}
                            size={22}
                            className="ring-2 ring-card"
                        />
                    ))}
                </span>
            )}
            {/* A blue link icon marks "anyone with the link"; the words stay quiet. */}
            {links > 0 && (
                <Link2Icon
                    className="size-3.5 shrink-0 text-primary"
                    strokeWidth={2.4}
                    aria-hidden="true"
                />
            )}
            <span className="min-w-0 truncate text-muted-foreground">
                {people.length === 1 && people[0]!.name}
                {people.length > 1 && `${people.length} people`}
                {people.length > 0 && links > 0 && ' · '}
                {links > 0 && (people.length ? 'link' : 'Anyone with the link')}
            </span>
        </span>
    );
}
